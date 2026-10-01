import type { GuardianFinding } from '@fbrx/shared';
import type { ToolResources, ToolSpec } from '../tools/types';

interface Detector {
  code: string;
  severity: GuardianFinding['severity'];
  message: string;
  re: RegExp;
}

/** Command-line patterns that indicate high-impact or suspicious intent. */
const COMMAND_DETECTORS: Detector[] = [
  { code: 'privilege-escalation', severity: 'warning', message: 'Requests elevated privileges', re: /\b(sudo|doas|runas|Start-Process\b.*-Verb\s+RunAs)\b/i },
  { code: 'credential-access', severity: 'critical', message: 'Attempts to read credential stores', re: /(security\s+(find|dump)-(generic|internet)-password|\bmimikatz\b|sekurlsa|lsass|\.ssh\/id_|Credentials\\|cmdkey\s+\/list|\/etc\/shadow)/i },
  { code: 'defense-evasion', severity: 'critical', message: 'Attempts to disable security controls', re: /(Set-MpPreference\b.*Disable|spctl\s+--master-disable|csrutil\s+disable|setenforce\s+0|ufw\s+disable|netsh\s+advfirewall\s+set\s+\w+\s+state\s+off)/i },
  { code: 'persistence', severity: 'warning', message: 'Creates persistence (scheduled task / autorun)', re: /(\bcrontab\b|launchctl\s+(load|bootstrap)|schtasks\s+\/create|\\CurrentVersion\\Run\b|systemctl\s+enable)/i },
  { code: 'obfuscation', severity: 'critical', message: 'Executes obfuscated or encoded payloads', re: /(base64\s+(-d|--decode)[^|]*\|\s*(ba|z)?sh|powershell(\.exe)?\s+.*-(e|enc|encodedcommand)\s|FromBase64String|\bIEX\s*\(|Invoke-Expression)/i },
  { code: 'exfiltration', severity: 'warning', message: 'May send local data to a remote host', re: /(curl\b.*(-d\s*@|--data-binary\s*@|-T\s|--upload-file)|\bnc\s+-?\w*\s+\S+\s+\d+\s*<|scp\s+\S+\s+\S+@)/i },
  { code: 'destructive', severity: 'warning', message: 'Deletes or overwrites data', re: /(\brm\s+-\w*r|\bdel\s+\/s|Remove-Item\b.*-Recurse|\bshred\b|\btruncate\b|\bgit\s+push\s+.*--force|\bDROP\s+(TABLE|DATABASE)\b)/i },
];

const SYSTEM_PATHS = [/^\/(etc|bin|sbin|usr|System|Library|private\/etc|boot|var\/root)(\/|$)/i, /^[a-z]:\\(windows|program files|programdata)(\\|$)/i];

const INJECTION_MARKERS = [
  /ignore (all|any|the)? ?(previous|prior|above) (instructions|prompts)/i,
  /disregard (your|the) (system|previous) prompt/i,
  /you are now (in )?(developer|dan|jailbreak) mode/i,
  /<\s*\/?\s*system\s*>/i,
  /reveal (your|the) (system prompt|instructions|api key|secrets?)/i,
  /exfiltrate|send (the|all) (secrets|credentials|passwords) to/i,
];

export type ModelReviewer = (tool: ToolSpec, input: unknown) => Promise<GuardianFinding[]>;

/**
 * The guardian is an independent reviewer for tool calls. Deterministic detectors always run; an optional
 * model-assisted review adds judgment for ambiguous calls. Critical findings block a call outright, warnings
 * force a human approval even when policy would allow it.
 */
export class Guardian {
  private modelReviewer: ModelReviewer | null = null;

  setModelReviewer(fn: ModelReviewer | null) {
    this.modelReviewer = fn;
  }

  reviewCall(tool: ToolSpec, input: unknown, resources: ToolResources): GuardianFinding[] {
    const findings: GuardianFinding[] = [];
    if (resources.command) {
      for (const d of COMMAND_DETECTORS) {
        if (d.re.test(resources.command)) findings.push({ severity: d.severity, code: d.code, message: d.message });
      }
    }
    for (const p of resources.paths ?? []) {
      if (p.access === 'write' && SYSTEM_PATHS.some((re) => re.test(p.path))) {
        findings.push({ severity: 'critical', code: 'system-path-write', message: `Writes to a system location: ${p.path}` });
      }
    }
    const serialized = safeJson(input);
    if (serialized.length > 200_000) {
      findings.push({ severity: 'warning', code: 'oversized-input', message: 'Unusually large tool input' });
    }
    if (INJECTION_MARKERS.some((re) => re.test(serialized))) {
      findings.push({ severity: 'warning', code: 'prompt-injection', message: 'Tool input contains prompt-injection language' });
    }
    return findings;
  }

  async modelReview(tool: ToolSpec, input: unknown): Promise<GuardianFinding[]> {
    if (!this.modelReviewer) return [];
    try {
      return await this.modelReviewer(tool, input);
    } catch (err) {
      return [{ severity: 'info', code: 'model-review-unavailable', message: `Model review skipped: ${(err as Error).message}` }];
    }
  }

  /** Flags tool output that tries to steer the model; the agent wraps such output with a warning. */
  scanOutput(text: string): GuardianFinding[] {
    return INJECTION_MARKERS.some((re) => re.test(text))
      ? [{ severity: 'warning', code: 'output-injection', message: 'Tool output contains instructions aimed at the AI; treated as untrusted data' }]
      : [];
  }
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}
