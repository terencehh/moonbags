import { formatDoctorPlain, runDoctor } from "./doctor.js";

const noNetwork = process.argv.includes("--no-network");
const report = await runDoctor({ network: !noNetwork });

console.log(formatDoctorPlain(report));
process.exitCode = report.ok ? 0 : 1;

