import { PrismaClient } from '@prisma/client/react-native';
import { PrismaExpoSQLite } from '@prisma/adapter-expo-sqlite';
import * as SQLite from 'expo-sqlite';

const expoDb = SQLite.openDatabaseSync('finance.db');
const adapter = new PrismaExpoSQLite(expoDb);

export const localDb = new PrismaClient({ adapter });
