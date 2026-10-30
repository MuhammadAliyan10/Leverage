import assert from 'node:assert/strict';
import test from 'node:test';
import { decideOnboardingRoute } from '../../src/security/onboardingRoutePolicy.ts';

test('a returning profile leaves onboarding immediately while cloud pull continues in the background', () => {
  assert.equal(decideOnboardingRoute({ isSignedIn:true,isComplete:false,isRequired:false,onDashboardEntry:false,onOnboarding:true,manualRequest:false }), 'tabs');
});

test('only a profile explicitly marked as first-run is routed to setup', () => {
  assert.equal(decideOnboardingRoute({ isSignedIn:true,isComplete:false,isRequired:true,onDashboardEntry:true,onOnboarding:false,manualRequest:false }), 'onboarding');
});

test('manual account creation remains available to a returning profile', () => {
  assert.equal(decideOnboardingRoute({ isSignedIn:true,isComplete:false,isRequired:false,onDashboardEntry:false,onOnboarding:true,manualRequest:true }), null);
});

test('signed-out users are not routed by profile setup state', () => {
  assert.equal(decideOnboardingRoute({ isSignedIn:false,isComplete:false,isRequired:true,onDashboardEntry:true,onOnboarding:false,manualRequest:false }), null);
});
