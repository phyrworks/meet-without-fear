export interface ExistingStrategyForDedupe {
  id: string;
  description: string;
}

function normalizeStrategy(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2);
}

function isMoreSpecificStrategy(existing: string, next: string): boolean {
  return normalizeStrategy(next).length >= normalizeStrategy(existing).length;
}

export function isSupersededStrategy(existing: string, next: string): boolean {
  const existingWords = new Set(normalizeStrategy(existing));
  const nextWords = new Set(normalizeStrategy(next));
  if (existingWords.size === 0 || nextWords.size === 0) return false;
  const intersection = [...existingWords].filter(word => nextWords.has(word)).length;
  const smallerSetSize = Math.min(existingWords.size, nextWords.size);
  return intersection / smallerSetSize >= 0.65 && isMoreSpecificStrategy(existing, next);
}

export function filterNewStrategiesAgainstExisting(
  existingStrategies: ExistingStrategyForDedupe[],
  proposedStrategies: string[],
): { newStrategies: string[]; supersededIds: string[] } {
  const supersededIds = new Set<string>();
  const existingDescriptions = new Set(existingStrategies.map(s => s.description.toLowerCase()));
  const newStrategies = proposedStrategies.filter(desc => {
    if (existingDescriptions.has(desc.toLowerCase())) {
      return false;
    }
    existingStrategies.forEach(existing => {
      if (isSupersededStrategy(existing.description, desc)) {
        supersededIds.add(existing.id);
      }
    });
    return true;
  });

  return { newStrategies, supersededIds: [...supersededIds] };
}
