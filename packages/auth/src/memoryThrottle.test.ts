import { MemoryThrottle } from "./memoryThrottle";
import { runThrottleConformance } from "./throttleConformance";

runThrottleConformance(() => {
  const throttle = new MemoryThrottle();
  let offset = 0;
  throttle.now = () => Date.now() + offset;
  return {
    throttle,
    advance: async (seconds) => {
      offset += seconds * 1000;
    },
  };
}, "MemoryThrottle");
