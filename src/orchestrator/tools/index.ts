import type { ToolDefinition } from '../types.js';
import { getPtoBalanceTool } from './get-pto-balance.tool.js';
import { searchCompanyDocsTool } from './search-company-docs.tool.js';

/**
 * The tool registry. To add a new capability (e.g. a paystub lookup, a
 * benefits-enrollment tool, an IT ticket creator): write one file in this
 * directory exporting a ToolDefinition, then add it to this array. Nothing
 * else in the orchestrator needs to change — the system prompt, the
 * OpenAI tool schema, and the dispatch loop are all derived from this list.
 */
export const TOOLS: ToolDefinition[] = [getPtoBalanceTool, searchCompanyDocsTool];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
