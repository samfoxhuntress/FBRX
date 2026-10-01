import type { GuardianFinding } from '@fbrx/shared';
import type { Kernel } from '../kernel';
import { errorMessage } from '../errors';

const PROMPT = `You are the FBRX OS guardian, an independent security reviewer for an AI agent's tool calls.
Assess whether the tool call below is safe and consistent with an ordinary user's intent on a business workstation.
Respond with ONLY a JSON object: {"verdict": "allow" | "review" | "block", "reason": "<one sentence>"}.
Use "block" for clear harm (data destruction, credential theft, disabling security, exfiltration),
"review" when a human should look first, and "allow" otherwise.`;

/** Optional model-assisted guardian review, enabled by policy (ai.guardianModelReview). */
export function installModelReviewer(k: Kernel): void {
  k.guardian.setModelReviewer(async (tool, input): Promise<GuardianFinding[]> => {
    const { provider, model } = k.providers.resolve();
    const signal = AbortSignal.timeout(20_000);
    let text = '';
    for await (const chunk of provider.chat({
      model,
      signal,
      tools: [],
      maxTokens: 300,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: `Tool: ${tool.name} (${tool.title}, risk ${tool.risk})\nDescription: ${tool.description}\nInput:\n${JSON.stringify(input, null, 2).slice(0, 8000)}` },
      ],
    })) {
      if (chunk.type === 'text') text += chunk.delta;
    }
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return [{ severity: 'info', code: 'model-review-unparsed', message: 'Guardian model returned no verdict' }];
    try {
      const v = JSON.parse(m[0]) as { verdict?: string; reason?: string };
      if (v.verdict === 'block') return [{ severity: 'critical', code: 'model-review-block', message: v.reason ?? 'Blocked by guardian model' }];
      if (v.verdict === 'review') return [{ severity: 'warning', code: 'model-review', message: v.reason ?? 'Guardian model recommends review' }];
      return [];
    } catch (err) {
      return [{ severity: 'info', code: 'model-review-unparsed', message: errorMessage(err) }];
    }
  });
}
