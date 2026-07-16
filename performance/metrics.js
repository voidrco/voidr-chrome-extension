const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

export function aggregate(values) {
  const present = values.filter((value) => value !== undefined && value !== null);
  if (present.length === 0) return null;
  if (present.every((value) => typeof value === 'number')) return median(present);
  if (present.every((value) => typeof value === 'boolean')) return present.every(Boolean);
  if (present.every(Array.isArray)) return [...new Set(present.flat())];
  if (!present.every((value) => typeof value === 'object' && !Array.isArray(value))) {
    return present[0];
  }

  const keys = [...new Set(present.flatMap((value) => Object.keys(value)))];
  return Object.fromEntries(
    keys.map((key) => [key, aggregate(present.map((value) => value[key]))]),
  );
}

const ratio = (active, control) => {
  if (control === 0) return active === 0 ? 1 : null;
  return active / control;
};

export function compare(active, control) {
  if (typeof active === 'number' && typeof control === 'number') {
    return { control, active, delta: active - control, ratio: ratio(active, control) };
  }
  if (!active || !control || typeof active !== 'object' || typeof control !== 'object') {
    return null;
  }

  const keys = [...new Set([...Object.keys(active), ...Object.keys(control)])];
  return Object.fromEntries(
    keys
      .map((key) => [key, compare(active[key], control[key])])
      .filter(([, value]) => value !== null),
  );
}

export function summarizeSamples(samples) {
  const modes = [...new Set(samples.map((sample) => sample.mode))];
  const summary = Object.fromEntries(
    modes.map((mode) => [mode, aggregate(samples.filter((sample) => sample.mode === mode))]),
  );
  const pairedImpact = aggregate(
    [...new Set(samples.map((sample) => sample.iteration))]
      .map((iteration) => {
        const active = samples.find(
          (sample) => sample.iteration === iteration && sample.mode === 'active',
        );
        const control = samples.find(
          (sample) => sample.iteration === iteration && sample.mode === 'off',
        );
        return active && control ? compare(active, control) : null;
      })
      .filter(Boolean),
  );
  return {
    modes: summary,
    impact: pairedImpact,
  };
}
