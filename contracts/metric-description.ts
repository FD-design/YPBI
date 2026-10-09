/** Resolve the authority's business description without changing its source text. */
export function metricBusinessDefinition(authority: { definition: string; recommendedDefinition?: string | null }): string {
  const recommended = authority.recommendedDefinition?.trim();
  return recommended && !/^与现有定义一致[。.]?$/.test(recommended) ? authority.recommendedDefinition! : authority.definition;
}
