import { newId, type GuardianFinding, type ToolInvokeResult } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { AuditLog } from '../audit/audit-log';
import type { Logger } from '../logger';
import type { LicenseService } from '../license/license-service';
import type { ToolRegistry } from '../tools/registry';
import type { InvocationContext, ToolResources, ToolSpec } from '../tools/types';
import { validateInput } from '../tools/json-schema';
import { truncate } from '../util/misc';
import type { ApprovalQueue } from './approvals';
import type { Guardian } from './guardian';
import type { PolicyEngine } from './policy-engine';
import type { RateLimiter } from './rate-limiter';
import type { Redactor } from './redactor';

export interface GateResult extends ToolInvokeResult {
  status: 'succeeded' | 'failed' | 'denied';
  findings: GuardianFinding[];
  callId: string;
}

export interface GateHooks {
  onAwaitingApproval?(info: { findings: GuardianFinding[]; reason: string }): void;
  onRunning?(): void;
}

const MAX_OUTPUT = 24_000;

/**
 * The single choke point every tool invocation passes through, regardless of origin (agent, UI, Local API,
 * remote command): license → enabled → schema → rate limit → policy → guardian → approval → execute →
 * redact → audit.
 */
export class ToolGate {
  constructor(
    private readonly d: {
      registry: ToolRegistry;
      policy: PolicyEngine;
      guardian: Guardian;
      approvals: ApprovalQueue;
      redactor: Redactor;
      audit: AuditLog;
      license: LicenseService;
      limiter: RateLimiter;
      log: Logger;
      /** Why AI agents may not use any tool on this computer (a student computer), or null. */
      agentToolsBlocked?: () => string | null;
    },
  ) {}

  async invoke(name: string, rawInput: unknown, ctx: InvocationContext, hooks: GateHooks = {}): Promise<GateResult> {
    const callId = newId('call');
    const started = Date.now();
    const tool = this.d.registry.get(name);
    const deny = (reason: string, findings: GuardianFinding[] = [], details: Record<string, unknown> = {}): GateResult => {
      this.d.audit.append({
        category: 'tool',
        action: name,
        actor: ctx.actor,
        target: tool?.sourceId ?? null,
        outcome: 'denied',
        details: { callId, origin: ctx.origin, runId: ctx.runId ?? null, reason, findings, ...details },
      });
      return { ok: false, status: 'denied', output: `Denied: ${reason}`, error: reason, durationMs: Date.now() - started, findings, callId };
    };

    if (!tool) return deny(`Unknown tool "${name}"`);
    const blocked = ctx.origin === 'agent' ? this.d.agentToolsBlocked?.() : null;
    if (blocked) return deny(blocked);
    if (tool.feature && !this.d.license.has(tool.feature)) return deny(`Tool requires the "${tool.feature}" license feature`);
    if (!this.d.registry.isEnabled(name)) return deny('Tool is disabled on this workstation');
    const unavailable = tool.unavailable?.();
    if (unavailable) return deny(unavailable);

    const validated = validateInput(tool.inputSchema, rawInput);
    if (!validated.ok) {
      return { ok: false, status: 'failed', output: `Invalid input: ${validated.errors.join('; ')}`, error: validated.errors.join('; '), durationMs: 0, findings: [], callId };
    }
    const input = validated.value;

    if (!this.d.limiter.tryAcquire()) return deny('Tool call rate limit exceeded; try again shortly');

    let resources: ToolResources = {};
    try {
      resources = (await tool.resources?.(input)) ?? {};
    } catch (err) {
      return { ok: false, status: 'failed', output: `Invalid input: ${errorMessage(err)}`, error: errorMessage(err), durationMs: 0, findings: [], callId };
    }

    const decision = await this.d.policy.evaluate(tool, resources);
    const findings = this.d.guardian.reviewCall(tool, input, resources);
    if (this.d.policy.policy.ai.guardianModelReview && tool.risk !== 'read' && this.d.license.has('guardian.model')) {
      findings.push(...(await this.d.guardian.modelReview(tool, input)));
    }
    if (decision.hardViolations.length) return deny(decision.reason, findings, { violations: decision.hardViolations });
    const critical = findings.find((f) => f.severity === 'critical');
    if (critical) return deny(`Guardian blocked the call: ${critical.message}`, findings);
    if (decision.action === 'deny') return deny(decision.reason, findings, { ruleId: decision.ruleId });

    const needsApproval = decision.action === 'ask' || findings.some((f) => f.severity === 'warning');
    // A person invoking a tool directly from the UI is the approval.
    if (needsApproval && ctx.origin !== 'user') {
      const reason = decision.action === 'ask' ? decision.reason : `Guardian: ${findings.map((f) => f.message).join('; ')}`;
      hooks.onAwaitingApproval?.({ findings, reason });
      const policy = this.d.policy.policy;
      const answer = await this.d.approvals.request(
        {
          runId: ctx.runId ?? null,
          tool: tool.name,
          toolTitle: tool.title,
          risk: tool.risk,
          input,
          reason,
          origin: ctx.origin,
          findings,
        },
        policy.approvals.timeoutSeconds,
        ctx.signal,
      );
      if (answer.decision !== 'approve') {
        return deny(answer.decision === 'expired' ? 'Approval request expired' : `Rejected by ${answer.by}`, findings);
      }
      if (answer.remember && decision.action === 'ask' && !findings.length) {
        this.d.policy.remember(tool.name);
      }
      this.d.audit.append({
        category: 'approval',
        action: 'approved',
        actor: answer.by,
        target: tool.name,
        outcome: 'success',
        details: { callId, remember: answer.remember },
      });
    }

    hooks.onRunning?.();
    const controller = new AbortController();
    const onAbort = () => controller.abort(ctx.signal?.reason);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new CoreError('TIMEOUT', 'Tool timed out')), tool.timeoutMs ?? 120_000);
    try {
      const out = await tool.run(input, {
        callId,
        origin: ctx.origin,
        actor: ctx.actor,
        runId: ctx.runId ?? null,
        signal: controller.signal,
      });
      const redacted = this.d.redactor.redact(out.output);
      const outputFindings = this.d.guardian.scanOutput(redacted.text);
      const durationMs = Date.now() - started;
      this.d.audit.append({
        category: 'tool',
        action: tool.name,
        actor: ctx.actor,
        target: tool.sourceId,
        outcome: 'success',
        details: {
          callId,
          origin: ctx.origin,
          runId: ctx.runId ?? null,
          durationMs,
          redactions: redacted.count,
          resources: summarize(resources),
          softDenied: decision.softDenied || undefined,
        },
      });
      return {
        ok: true,
        status: 'succeeded',
        output: truncate(redacted.text, MAX_OUTPUT),
        data: out.data,
        durationMs,
        findings: [...findings, ...outputFindings],
        callId,
      };
    } catch (err) {
      const msg = controller.signal.aborted && !(ctx.signal?.aborted) ? 'Tool timed out' : errorMessage(err);
      const safe = this.d.redactor.redact(msg).text;
      this.d.audit.append({
        category: 'tool',
        action: tool.name,
        actor: ctx.actor,
        target: tool.sourceId,
        outcome: 'failure',
        details: { callId, origin: ctx.origin, runId: ctx.runId ?? null, error: safe },
      });
      return { ok: false, status: 'failed', output: `Error: ${safe}`, error: safe, durationMs: Date.now() - started, findings, callId };
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Lists tools with their static policy action, for UIs and the model's tool list. */
  describe(spec: ToolSpec) {
    return this.d.registry.toInfo(spec, this.d.policy.staticAction(spec).action);
  }
}

function summarize(r: ToolResources) {
  return {
    paths: r.paths?.map((p) => `${p.access}:${p.path}`),
    urls: r.urls,
    command: r.command ? truncate(r.command, 300) : undefined,
  };
}
