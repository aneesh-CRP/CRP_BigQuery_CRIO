import { describe, it, expect, vi } from 'vitest';

// vi.mock calls are hoisted by Vitest's transformer to before all imports
vi.mock('../lib/logger.ts');
vi.mock('../tools/bigquery.ts', () => ({
    createBigQueryTools: () => ({
        listTables: undefined,
        getTableSchema: undefined,
        executeBigQuery: undefined,
    }),
}));
vi.mock('@google/adk', () => ({
    LlmAgent: class LlmAgent {
        instruction: string;
        constructor(opts: any) {
            this.instruction = opts.instruction ?? '';
        }
    },
}));
// @ts-ignore
import config from '../config.json' with { type: 'json' };

const grounding = (config as any).grounding;

describe('config.grounding structure', () => {
    // Feature: clinical-research-grounding, Property 1: Terminology values are non-empty strings
    // Validates: Requirements 1.3, 2.1, 2.2, 2.3, 2.5, 8.1
    describe('Property 1: Terminology values are non-empty strings', () => {
        it('every terminology entry has a non-empty string value', () => {
            const terminology = grounding.terminology as Record<string, string>;
            const entries = Object.entries(terminology);
            expect(entries.length).toBeGreaterThan(0);
            for (const [term, definition] of entries) {
                expect(typeof definition, `term "${term}" should have a string value`).toBe('string');
                expect(definition.trim().length, `term "${term}" should have a non-empty definition`).toBeGreaterThan(0);
            }
        });
    });

    // Feature: clinical-research-grounding, Property 2: Array-typed grounding fields are non-empty arrays of strings
    // Validates: Requirements 1.4, 1.5
    describe('Property 2: Array-typed grounding fields are non-empty arrays of strings', () => {
        it('keyRelationships is a non-empty array of non-empty strings', () => {
            const keyRelationships = grounding.keyRelationships as string[];
            expect(Array.isArray(keyRelationships)).toBe(true);
            expect(keyRelationships.length).toBeGreaterThan(0);
            for (const rel of keyRelationships) {
                expect(typeof rel).toBe('string');
                expect(rel.trim().length).toBeGreaterThan(0);
            }
        });

        it('commonFilters is a non-empty array of non-empty strings', () => {
            const commonFilters = grounding.commonFilters as string[];
            expect(Array.isArray(commonFilters)).toBe(true);
            expect(commonFilters.length).toBeGreaterThan(0);
            for (const filter of commonFilters) {
                expect(typeof filter).toBe('string');
                expect(filter.trim().length).toBeGreaterThan(0);
            }
        });
    });

    // Feature: clinical-research-grounding, Property 3: StatusCodes groups map to objects with non-empty string values
    // Validates: Requirements 1.6, 5.1–5.10, 8.3
    describe('Property 3: StatusCodes groups map to objects with non-empty string values', () => {
        it('every statusCodes group maps to an object with non-empty string values', () => {
            const statusCodes = grounding.statusCodes as Record<string, Record<string, string>>;
            const groups = Object.entries(statusCodes);
            expect(groups.length).toBeGreaterThan(0);
            for (const [group, codes] of groups) {
                expect(typeof codes, `group "${group}" should be an object`).toBe('object');
                expect(codes).not.toBeNull();
                const codeEntries = Object.entries(codes);
                expect(codeEntries.length, `group "${group}" should have at least one code`).toBeGreaterThan(0);
                for (const [code, label] of codeEntries) {
                    expect(typeof label, `${group}[${code}] should be a string`).toBe('string');
                    expect(label.trim().length, `${group}[${code}] should be non-empty`).toBeGreaterThan(0);
                }
            }
        });
    });

    // Feature: clinical-research-grounding, Property 4: PreferredTables values are non-empty arrays of strings
    // Validates: Requirements 1.7, 3.1–3.10, 8.2
    describe('Property 4: PreferredTables values are non-empty arrays of strings', () => {
        it('every preferredTables category maps to a non-empty array of non-empty strings', () => {
            const preferredTables = grounding.preferredTables as Record<string, string[]>;
            const categories = Object.entries(preferredTables);
            expect(categories.length).toBeGreaterThan(0);
            for (const [category, tables] of categories) {
                expect(Array.isArray(tables), `category "${category}" should be an array`).toBe(true);
                expect(tables.length, `category "${category}" should have at least one table`).toBeGreaterThan(0);
                for (const table of tables) {
                    expect(typeof table, `table in "${category}" should be a string`).toBe('string');
                    expect(table.trim().length, `table in "${category}" should be non-empty`).toBeGreaterThan(0);
                }
            }
        });
    });
});

const { createSqlAgent } = await import('../agents/sql_agent.ts');

// Feature: clinical-research-grounding, Property 5: Grounding config round-trip into instruction
// Validates: Requirements 7.1–7.7, 8.4–8.10
describe('sql agent instruction', () => {
    const agent = createSqlAgent();
    const instruction = (agent as any).instruction as string;

    it('contains ### Domain Knowledge heading', () => {
        expect(instruction).toContain('### Domain Knowledge');
    });

    it('contains domainDescription text verbatim', () => {
        // Use a distinctive substring of the domainDescription
        const substring = 'clinical research data warehouse';
        expect(instruction).toContain(substring);
    });

    it('contains is_active = 1 filter', () => {
        expect(instruction).toContain('is_active = 1');
    });

    it('contains %test% and %demo% exclusion text', () => {
        expect(instruction).toContain('%test%');
        expect(instruction).toContain('%demo%');
    });

    it('contains "Subject" term and its definition', () => {
        const terminology = grounding.terminology as Record<string, string>;
        expect(instruction).toContain('"Subject"');
        expect(instruction).toContain(terminology['Subject']);
    });

    it('contains "Patient" term and its definition', () => {
        const terminology = grounding.terminology as Record<string, string>;
        expect(instruction).toContain('"Patient"');
        expect(instruction).toContain(terminology['Patient']);
    });

    it('contains at least one keyRelationship', () => {
        const firstRelationship = (grounding.keyRelationships as string[])[0];
        expect(instruction).toContain(firstRelationship);
    });

    it('### Domain Knowledge appears after ### Rules', () => {
        const rulesIndex = instruction.indexOf('### Rules');
        const domainKnowledgeIndex = instruction.indexOf('### Domain Knowledge');
        expect(rulesIndex).toBeGreaterThan(-1);
        expect(domainKnowledgeIndex).toBeGreaterThan(-1);
        expect(domainKnowledgeIndex).toBeGreaterThan(rulesIndex);
    });
});
