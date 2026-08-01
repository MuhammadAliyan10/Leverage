import { localDb } from '../src/db/local/client';
import * as Network from 'expo-network';

export async function syncOfflineData() {
  try {
    const networkState = await Network.getNetworkStateAsync();
    
    if (!networkState.isConnected || !networkState.isInternetReachable) {
      console.log('Sync skipped: Device is offline');
      return false;
    }

    console.log('Starting sync engine...');

    // Fetch all unsynced transactions
    const unsyncedTransactions = await localDb.transaction.findMany({
      where: { synced: false }
    });

    if (unsyncedTransactions.length > 0) {
      console.log(`Pushing ${unsyncedTransactions.length} transactions to cloud...`);
      
      // MOCK: In a real app, this would be a fetch() call to the backend API or Neon.
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Mark as synced locally
      for (const tx of unsyncedTransactions) {
        await localDb.transaction.update({
          where: { id: tx.id },
          data: { synced: true }
        });
      }
      console.log('Transactions synced successfully.');
    } else {
      console.log('No unsynced transactions found.');
    }

    return true;
  } catch (error) {
    console.error('Sync failed:', error);
    return false;
  }
}
