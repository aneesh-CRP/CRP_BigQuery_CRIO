import { describe, it, expect } from 'vitest';
import { sanitizeErrorForUser } from '../tools/bigquery.ts';

describe('sanitizeErrorForUser', () => {
    it('returns generic access denied message', () => {
        const result = sanitizeErrorForUser('Access Denied: User user@example.com does not have bigquery.jobs.create in project my-billing-proj', 'accessDenied');
        expect(result).toContain('Access denied');
        expect(result).not.toContain('user@example.com');
        expect(result).not.toContain('my-billing-proj');
    });

    it('returns generic not found message', () => {
        const result = sanitizeErrorForUser('Not found: Table my-project.my-dataset.patients was not found', 'notFound');
        expect(result).toContain('not found');
        expect(result).not.toContain('my-project');
        expect(result).not.toContain('my-dataset');
    });

    it('returns timeout message for deadline exceeded', () => {
        const result = sanitizeErrorForUser('Deadline exceeded while waiting for query');
        expect(result).toContain('timed out');
    });

    it('returns byte limit message', () => {
        const result = sanitizeErrorForUser('Query exceeded maximum bytes billed: 1073741824');
        expect(result).toContain('too much data');
    });

    it('passes through syntax errors (safe to show)', () => {
        const result = sanitizeErrorForUser('Syntax error: Unexpected keyword SELECT at [1:5]');
        expect(result).toContain('Syntax error');
        expect(result).toContain('SQL Error');
    });

    it('returns generic fallback for unknown errors', () => {
        const result = sanitizeErrorForUser(
            'Internal error in billing project my-secret-project with dataset my-dataset at location us-central1',
            'internalError'
        );
        expect(result).not.toContain('my-secret-project');
        expect(result).not.toContain('my-dataset');
        expect(result).not.toContain('us-central1');
        expect(result).toContain('internalError');
    });

    it('strips token email from access denied messages', () => {
        const result = sanitizeErrorForUser('Access denied for user: admin@company.com');
        expect(result).not.toContain('admin@company.com');
        expect(result).toContain('Access denied');
    });
});
