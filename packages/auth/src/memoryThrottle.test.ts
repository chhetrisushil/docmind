import { MemoryThrottle } from "./memoryThrottle";
import { runThrottleConformance } from "./throttleConformance";

runThrottleConformance(() => {
  const throttle = new MemoryThrottle();
  let t = 0;
  throttle.now = () => t;
  return {
    throttle,
    advance: async (seconds) => {
      t += seconds * 1000;
    },
  };
}, "MemoryThrottle");
