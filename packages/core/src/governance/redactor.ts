const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g },
  { name: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe-key', re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{24,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'fbrx-token', re: /\bfbrx_(dev|ak|lapi|enr)_[A-Za-z0-9_-]{20,}\b/g },
];

/** Scrubs vault secret values and well-known credential formats from text before it reaches a model or log. */
export class Redactor {
  private secrets: Array<{ name: string; value: string }> = [];

  setSecrets(secrets: Array<{ name: string; value: string }>) {
    // Longest first so overlapping values redact fully.
    this.secrets = [...secrets].sort((a, b) => b.value.length - a.value.length);
  }

  redact(text: string): { text: string; count: number } {
    let count = 0;
    let out = text;
    for (const s of this.secrets) {
      if (!s.value || s.value.length < 4) continue;
      const parts = out.split(s.value);
      if (parts.length > 1) {
        count += parts.length - 1;
        out = parts.join(`[REDACTED:${s.name}]`);
      }
    }
    for (const p of PATTERNS) {
      out = out.replace(p.re, () => {
        count++;
        return `[REDACTED:${p.name}]`;
      });
    }
    return { text: out, count };
  }
}
