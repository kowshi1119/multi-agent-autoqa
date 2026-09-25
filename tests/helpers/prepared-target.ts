/**
 * Obtains the prepared target the same way the control panel does: from the
 * readiness response. Operations must echo it back as `expected`.
 */
export async function preparedTarget(baseUrl: string, profileId: string, mode: "demo" | "live" = "demo"): Promise<{ fingerprint: string; origin: string }> {
  const response = await fetch(`${baseUrl}/api/preflight?profileId=${encodeURIComponent(profileId)}&mode=${mode}`);
  const report = (await response.json()) as { target?: { fingerprint: string; origin: string } };
  if (!report.target) throw new Error(`No prepared target returned for ${profileId}`);
  return { fingerprint: report.target.fingerprint, origin: report.target.origin };
}
