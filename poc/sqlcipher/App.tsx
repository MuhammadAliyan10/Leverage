import { useState } from 'react';
import { Button, SafeAreaView, ScrollView, Text } from 'react-native';
import { runCipherProbe } from './probe';

export default function App() {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<string[]>([]);

  async function run(): Promise<void> {
    setRunning(true);
    setResults(['Running synthetic native checks…']);
    try {
      setResults(await runCipherProbe());
    } catch {
      setResults(['FAIL: native probe stopped safely. Inspect the failing step in the test harness.']);
    } finally {
      setRunning(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, padding: 20 }}>
      <Button title={running ? 'Running…' : 'Run disposable SQLCipher probe'} onPress={run} disabled={running} />
      <ScrollView style={{ marginTop: 20 }}>
        {results.map((result, index) => <Text key={index} style={{ marginBottom: 12 }}>{result}</Text>)}
      </ScrollView>
    </SafeAreaView>
  );
}
