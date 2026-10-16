import type { Plugin } from '@capybara-devtools/core';

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler(): GlobalHandler | undefined;
  setGlobalHandler(handler: GlobalHandler): void;
}

/** Records uncaught JS exceptions, then hands them to the previous handler (LogBox, crash reporters). */
export function errorUtilsPlugin(): Plugin {
  return {
    name: 'errors',
    setup(ctx) {
      const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
      if (!errorUtils?.getGlobalHandler || !errorUtils.setGlobalHandler) return;
      const previous = errorUtils.getGlobalHandler();
      const handler: GlobalHandler = (error, isFatal) => {
        try {
          const args = [ctx.serialize(error)];
          if (isFatal) args.push(ctx.serialize('(fatal)'));
          ctx.emit('log', { level: 'error', source: 'uncaught', args });
        } catch {
          // the original handler must still run
        }
        previous?.(error, isFatal);
      };
      errorUtils.setGlobalHandler(handler);
      return () => {
        if (errorUtils.getGlobalHandler() === handler && previous) errorUtils.setGlobalHandler(previous);
      };
    },
  };
}
