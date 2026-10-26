import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve('react-native-css-interop/package.json');
const packageRoot = dirname(packageJsonPath);
const target = join(packageRoot, 'dist/runtime/native/render-component.js');
const source = await readFile(target, 'utf8');

const oldSerializer = `function stringify(object) {
    const seen = new WeakSet();
    return JSON.stringify(object, function replace(_, value) {
        if (!(value !== null && typeof value === "object")) {
            return value;
        }
        if (seen.has(value)) {
            return "[Circular]";
        }
        seen.add(value);
        const newValue = Array.isArray(value) ? [] : {};
        for (const entry of Object.entries(value)) {
            newValue[entry[0]] = replace(entry[0], entry[1]);
        }
        seen.delete(value);
        return newValue;
    }, 2);
}`;

const safeSerializer = `function stringify(object) {
    const seen = new WeakSet();
    function sanitize(value, depth) {
        if (value === null || typeof value !== "object") {
            return typeof value === "function" ? "[Function]" : value;
        }
        if (depth > 5) {
            return "[Depth limit]";
        }
        if (seen.has(value)) {
            return "[Circular]";
        }
        const reactType = Object.getOwnPropertyDescriptor(value, "$$typeof");
        if (reactType && "value" in reactType && reactType.value) {
            return "[React element]";
        }
        seen.add(value);
        const output = Array.isArray(value) ? [] : {};
        for (const key of Object.keys(value).slice(0, 40)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            output[key] = !descriptor || !("value" in descriptor)
                ? "[Getter]"
                : sanitize(descriptor.value, depth + 1);
        }
        seen.delete(value);
        return output;
    }
    try {
        return JSON.stringify(sanitize(object, 0));
    }
    catch {
        return "[Component props unavailable]";
    }
}`;

if (source.includes(safeSerializer)) {
  console.log('Applied safe NativeWind warning serialization.');
} else if (source.includes(oldSerializer)) {
  await writeFile(target, source.replace(oldSerializer, safeSerializer));
  console.log('Patched NativeWind warning serialization to avoid evaluating prop getters.');
} else {
  console.warn('NativeWind warning serializer did not match this installed version; no files were changed.');
}
