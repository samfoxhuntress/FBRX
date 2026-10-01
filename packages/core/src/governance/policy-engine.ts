import {
  DEFAULT_POLICY,
  PolicySchema,
  newId,
  type EffectivePolicy,
  type Policy,
  type PolicyAction,
  type PolicyRule,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { Db } from '../storage/db';
import type { EventBus } from '../events';
import type { SpecialDirs } from '../platform';
import type { ToolResources, ToolSpec } from '../tools/types';
import { nameMatches } from '../util/misc';
import { checkPath, expandPathVars } from './path-guard';
import { checkUrl } from './network-guard';

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
  ruleId: string | null;
  /** Safety constraints that are enforced even in `audit` mode. */
  hardViolations: string[];
  /** Rule/risk denials that `audit` mode records but does not enforce. */
  softDenied: boolean;
}

/**
 * Evaluates every tool call against the effective policy:
 *   1. hard constraints (filesystem roots/deny patterns, network, shell) → deny
 *   2. explicit rules (first match wins), then remembered "always allow" rules
 *   3. risk-level defaults
 */
export class PolicyEngine {
  private cache: EffectivePolicy | null = null;

  constructor(
    private readonly db: Db,
    private readonly dirs: () => SpecialDirs & { workspace: string; data: string },
    private readonly events?: EventBus,
  ) {}

  effective(): EffectivePolicy {
    if (this.cache) return this.cache;
    const managed = this.db.get<{ data: string }>("SELECT data FROM policy_layers WHERE layer = 'managed'");
    const local = this.db.get<{ data: string }>("SELECT data FROM policy_layers WHERE layer = 'local'");
    let policy: Policy = DEFAULT_POLICY;
    let source: EffectivePolicy['source'] = 'default';
    for (const [row, src] of [
      [managed, 'managed'],
      [local, 'local'],
    ] as const) {
      if (!row) continue;
      const parsed = PolicySchema.safeParse(JSON.parse(row.data));
      if (parsed.success) {
        policy = parsed.data;
        source = src;
        break;
      }
    }
    const rememberedRules = policy.approvals.allowRemember
      ? this.db
          .all<{ rule: string }>('SELECT rule FROM remembered_rules ORDER BY created_at')
          .map((r) => JSON.parse(r.rule) as PolicyRule)
      : [];
    this.cache = { policy, source, rememberedRules };
    return this.cache;
  }

  get policy(): Policy {
    return this.effective().policy;
  }

  updateLocal(policy: Policy): EffectivePolicy {
    if (this.effective().source === 'managed') {
      throw new CoreError('MANAGED', 'Governance policy is managed by your organization');
    }
    const parsed = PolicySchema.parse(policy);
    validateRegexes(parsed);
    this.write('local', parsed);
    return this.invalidate();
  }

  applyManaged(policy: Policy | null): EffectivePolicy {
    if (policy === null) {
      this.db.run("DELETE FROM policy_layers WHERE layer = 'managed'");
    } else {
      const parsed = PolicySchema.parse(policy);
      validateRegexes(parsed);
      this.write('managed', parsed);
    }
    return this.invalidate();
  }

  remember(toolName: string): PolicyRule {
    if (!this.policy.approvals.allowRemember) throw new CoreError('FORBIDDEN', 'Remembered approvals are disabled by policy');
    const rule: PolicyRule = {
      id: newId('rr'),
      description: `Always allow ${toolName} (remembered approval)`,
      match: { tool: toolName },
      action: 'allow',
    };
    this.db.run('INSERT INTO remembered_rules (id, rule, created_at) VALUES (?, ?, ?)', rule.id, JSON.stringify(rule), new Date().toISOString());
    this.invalidate();
    return rule;
  }

  removeRemembered(id: string): EffectivePolicy {
    this.db.run('DELETE FROM remembered_rules WHERE id = ?', id);
    return this.invalidate();
  }

  private write(layer: 'local' | 'managed', policy: Policy) {
    this.db.run(
      `INSERT INTO policy_layers (layer, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(layer) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      layer,
      JSON.stringify(policy),
      new Date().toISOString(),
    );
  }

  private invalidate(): EffectivePolicy {
    this.cache = null;
    const eff = this.effective();
    this.events?.emit('policy.changed', eff);
    return eff;
  }

  allowedRoots(): string[] {
    return this.policy.filesystem.allowedRoots.map((r) => expandPathVars(r, this.dirs()));
  }

  /** Policy action for a tool ignoring inputs (used for listings). */
  staticAction(tool: Pick<ToolSpec, 'name' | 'source' | 'risk'>): { action: PolicyAction; ruleId: string | null } {
    const { policy, rememberedRules } = this.effective();
    for (const rule of [...policy.rules, ...rememberedRules]) {
      if (ruleMatches(rule, tool)) return { action: rule.action, ruleId: rule.id };
    }
    return { action: policy.riskDefaults[tool.risk] ?? policy.defaultAction, ruleId: null };
  }

  async evaluate(tool: ToolSpec, resources: ToolResources): Promise<PolicyDecision> {
    const policy = this.policy;
    const hard: string[] = [];

    for (const p of resources.paths ?? []) {
      const check = checkPath(p.path, p.access, {
        roots: this.allowedRoots(),
        denyPatterns: policy.filesystem.denyPatterns,
        readOnly: policy.filesystem.readOnly,
        dataDir: this.dirs().data,
      });
      if (!check.ok) hard.push(check.reason!);
    }
    for (const u of resources.urls ?? []) {
      const check = await checkUrl(u, policy.network);
      if (!check.ok) hard.push(check.reason!);
    }
    if (resources.command !== undefined) {
      if (!policy.shell.enabled) hard.push('Shell execution is disabled by policy');
      for (const pattern of policy.shell.blockedPatterns) {
        try {
          if (new RegExp(pattern, 'i').test(resources.command)) hard.push(`Command matches blocked pattern /${pattern}/`);
        } catch {
          /* invalid patterns are rejected at policy update time */
        }
      }
    }
    if (hard.length) {
      return { action: 'deny', reason: hard[0], ruleId: null, hardViolations: hard, softDenied: false };
    }

    const { action, ruleId } = this.staticAction(tool);
    const reason = ruleId
      ? `Matched policy rule ${ruleId}`
      : `Default for ${tool.risk} tools is "${action}"`;
    if (action === 'deny' && policy.mode === 'audit') {
      return { action: 'allow', reason: `${reason} (audit mode: not enforced)`, ruleId, hardViolations: [], softDenied: true };
    }
    return { action, reason, ruleId, hardViolations: [], softDenied: false };
  }
}

function ruleMatches(rule: PolicyRule, tool: Pick<ToolSpec, 'name' | 'source' | 'risk'>): boolean {
  if (rule.match.source && rule.match.source !== '*' && rule.match.source !== tool.source) return false;
  if (rule.match.risk && rule.match.risk !== tool.risk) return false;
  return nameMatches(rule.match.tool, tool.name);
}

function validateRegexes(p: Policy) {
  for (const pattern of p.shell.blockedPatterns) {
    try {
      new RegExp(pattern, 'i');
    } catch {
      throw new CoreError('INVALID_ARGUMENT', `Invalid shell pattern: ${pattern}`);
    }
  }
}
