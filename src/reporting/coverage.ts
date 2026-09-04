/**
 * "Heuristic coverage" — executed / applicable distinct (pageState, control,
 * heuristic) combinations ever offered. Explicitly NOT "application test
 * coverage" or code coverage; never label it that way in output.
 */
export function computeHeuristicCoverage(executed: number, applicable: number): number {
  return applicable === 0 ? 0 : executed / applicable;
}
