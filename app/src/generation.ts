// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * "Latest wins" for async actions (#264). Each `begin()` starts a new
 * generation and returns an `isCurrent()` check; once a newer `begin()` runs,
 * every older check reports `false`, so a slow response that resolves after
 * its action was superseded can be dropped instead of overwriting newer state.
 *
 *   const gen = createGeneration();
 *   const isCurrent = gen.begin();
 *   const r = await slowCall();
 *   if (!isCurrent()) return; // a newer call superseded this one
 */
export interface Generation {
  /** Start a new generation; the returned check is true until the next `begin()`. */
  begin: () => () => boolean;
}

export function createGeneration(): Generation {
  let current = 0;
  return {
    begin: () => {
      const mine = ++current;
      return () => mine === current;
    },
  };
}
