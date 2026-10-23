export interface LocalProfileIdentity {
  id: string;
  email: string;
}

export function resolveProfileSwitchTarget<T extends LocalProfileIdentity>(profiles: readonly T[], currentProfileId: string, targetProfileId: string): T {
  const target = profiles.find((profile) => profile.id === targetProfileId);
  if (!target || target.id === currentProfileId) throw new Error('Choose another available local profile.');
  return target;
}
