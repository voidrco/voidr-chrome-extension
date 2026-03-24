import { createCollector } from './collector.js';
import { VOIDR_VERSION } from './constants.js';

const VoidrCollector = createCollector();

// Global error-catching wrapper via Proxy
const SafeVoidrCollector = new Proxy(VoidrCollector, {
  get(target, prop) {
    const value = target[prop];

    // Return non-functions as-is
    if (typeof value !== 'function') {
      return value;
    }

    // Wrap functions in try-catch
    return function (...args) {
      try {
        const result = value.apply(target, args);

        // Catch async errors too
        if (result && typeof result.then === 'function') {
          return result.catch((error) => {
            console.error(`VoidrCollector: Error in ${String(prop)}:`, error);
            return undefined;
          });
        }

        return result;
      } catch (error) {
        console.error(`VoidrCollector: Error in ${String(prop)}:`, error);
        return undefined;
      }
    };
  },
});

export default SafeVoidrCollector;

if (typeof window !== 'undefined') {
  window.VoidrCollector = SafeVoidrCollector;
  console.log(`VoidrCollector v${VOIDR_VERSION} - Module loaded`);
}
