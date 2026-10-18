import * as Network from 'expo-network';

export async function syncOfflineData() {
  try {
    const networkState = await Network.getNetworkStateAsync();
    
    if (!networkState.isConnected || !networkState.isInternetReachable) {
      console.log('Sync skipped: Device is offline');
      return false;
    }

    // No authenticated backend endpoint exists yet. Leave records pending until
    // a server confirms an idempotent upload.
    console.warn('Sync unavailable: no backend endpoint is configured. Local records remain pending.');
    return false;
  } catch (error) {
    console.error('Sync failed:', error);
    return false;
  }
}
