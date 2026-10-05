import { describe, expect, it } from 'vitest';
import { ProvisioningFileSchema, macProfile, narrowTier, productNameFor, provisioningFromPreferences, resolveAudience, windowsScript } from '../src';

describe('device manager files', () => {
  const input = { organization: 'Hillside <Co-op> & Friends', label: 'Students', serverUrl: 'https://command.hillside.example', enrollmentToken: 'fbrx_enr_abc123def456', audience: 'student' as const };

  it('makes a Mac configuration profile with FBRX managed preferences', () => {
    const p = macProfile({ ...input, uuids: ['AAAA-1', 'BBBB-2'] });
    expect(p).toContain('<string>com.apple.ManagedClient.preferences</string>');
    expect(p).toContain('<key>com.fbrx.os</key>');
    expect(p).toMatch(/<key>EnrollmentToken<\/key>\s*<string>fbrx_enr_abc123def456<\/string>/);
    expect(p).toMatch(/<key>Audience<\/key>\s*<string>student<\/string>/);
    expect(p).toContain('Hillside &lt;Co-op&gt; &amp; Friends');
    expect(p).not.toContain('<Co-op>');
    // Balanced plist tags.
    for (const tag of ['dict', 'array', 'plist']) expect(p.split(`<${tag}`).length).toBe(p.split(`</${tag}>`).length);
  });

  it('turns managed preferences back into a provisioning file', () => {
    const prov = provisioningFromPreferences({ ServerURL: input.serverUrl, EnrollmentToken: input.enrollmentToken, Audience: 'student', Ignored: 1 });
    expect(ProvisioningFileSchema.parse(prov)).toMatchObject({ serverUrl: input.serverUrl, enrollmentToken: input.enrollmentToken, audience: 'student' });
    expect(provisioningFromPreferences({ ServerURL: input.serverUrl })).toBeNull();
    expect(provisioningFromPreferences({ ServerURL: input.serverUrl, EnrollmentToken: 'fbrx_enr_x1234567', Audience: 'admin' })).not.toHaveProperty('audience');
  });

  it('makes an Intune script that provisions and installs for all users', () => {
    const s = windowsScript({ ...input, installerUrl: "https://command.hillside.example/v1/downloads/rel/FBRX-OS-Setup-1.9.0.exe?et=it's" });
    expect(s).toContain("Join-Path $env:ProgramData 'FBRX OS'");
    expect(s).toContain('"audience": "student"');
    expect(s).toContain("'/S', '/allusers'");
    expect(s).toContain("et=it''s'");
    const json = s.slice(s.indexOf("@'") + 3, s.indexOf("'@"));
    expect(ProvisioningFileSchema.parse(JSON.parse(json))).toMatchObject({ serverUrl: input.serverUrl, audience: 'student' });
  });
});

describe('who uses a computer', () => {
  it('lets a computer narrow itself to a student computer, never widen', () => {
    expect(resolveAudience('education', null)).toBe('staff');
    expect(resolveAudience('education', 'staff', 'student')).toBe('student');
    expect(resolveAudience('education', 'student', 'staff')).toBe('student');
    expect(resolveAudience('business', 'student')).toBe('staff');
    expect(resolveAudience('home', null)).toBe('parent');
  });

  it('names the product and keeps groups at or below the license', () => {
    expect(productNameFor('basic', 'education', 'student')).toBe('FBRX OS Education');
    expect(productNameFor('ultra', 'education', 'staff')).toBe('FBRX Endpoint Ultra');
    expect(productNameFor('basic', 'home', 'child')).toBe('FBRX OS Home');
    expect(narrowTier('ultra', 'basic')).toBe('basic');
    expect(narrowTier('basic', 'ultra')).toBe('basic');
  });
});
