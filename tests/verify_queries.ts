import { createBigQueryTools } from '../tools/bigquery.ts';

const { executeBigQuery, listTables, getTableSchema } = createBigQueryTools();
import { rootAgent } from '../agent.ts';
import dotenv from 'dotenv';

dotenv.config();

const complexQueries = [
    {
        name: "Patient Count by Study (via Subject)",
        // Joining study -> subject
        // 'subject' represents a patient enrolled in a study
        sql: `
            SELECT s.study_key, s.nickname, COUNT(sub.subject_key) as subject_count
            FROM \`crio-468120.crio_data.study\` s
            LEFT JOIN \`crio-468120.crio_data.subject\` sub ON s.study_key = sub.study_key
            GROUP BY s.study_key, s.nickname
            LIMIT 5
        `
    },
    {
        name: "Completed Visits per Site",
        // Joining site -> subject_visit
        sql: `
            SELECT si.name, COUNT(sv.subject_visit_key) as completed_visits
            FROM \`crio-468120.crio_data.site\` si
            JOIN \`crio-468120.crio_data.subject_visit\` sv ON si.site_key = sv.site_key
            WHERE sv.status = 10 
            GROUP BY si.name
            LIMIT 5
        `
    },
    {
        name: "Invoices by Organization",
        // Joining organization -> invoice
        sql: `
            SELECT o.name, COUNT(i.invoice_key) as invoice_count, SUM(i.amount) as total_invoiced
            FROM \`crio-468120.crio_data.organization\` o
            JOIN \`crio-468120.crio_data.invoice\` i ON o.organization_key = i.organization_key
            GROUP BY o.name
            LIMIT 5
        `
    }
];

async function runTests() {
    console.log("Starting Complex Query Verification...");

    for (const test of complexQueries) {
        console.log(`\n-----------------------------------`);
        console.log(`Test: ${test.name}`);
        console.log(`Query: ${test.sql}`);

        try {
            const result = await (executeBigQuery as any).execute({ query: test.sql });
            if (result.status === 'success') {
                console.log("✅ Success!");
                // console.log("Report:", result.report); 
                // Only print report if needed, keeping it clean
                console.log("Result preview:", result.report.substring(0, 200) + "...");
            } else {
                console.error("❌ Failed:", result.report);
            }
        } catch (e: any) {
            console.error("❌ Exception:", e.message);
        }
    }
}

runTests().catch(console.error);
