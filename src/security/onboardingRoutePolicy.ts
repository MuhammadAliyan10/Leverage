export type OnboardingRouteDecision = 'onboarding' | 'tabs' | null;

/** Route only from local first-run state; cloud sync must never block navigation. */
export function decideOnboardingRoute(input: {
  isSignedIn: boolean;
  isComplete: boolean;
  isRequired: boolean;
  onDashboardEntry: boolean;
  onOnboarding: boolean;
  manualRequest: boolean;
}): OnboardingRouteDecision {
  if (!input.isSignedIn) return null;
  if (input.onDashboardEntry && input.isRequired && !input.isComplete) return 'onboarding';
  if (input.onOnboarding && (input.isComplete || (!input.manualRequest && !input.isRequired))) return 'tabs';
  return null;
}
