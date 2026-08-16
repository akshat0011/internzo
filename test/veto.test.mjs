/**
 * The vocabulary's veto over a model verdict.
 *
 * The veto is one-way by design: if the offline vocabulary confidently calls a
 * role non-engineering that stands whatever the model says, but a role the
 * vocabulary cannot settle is left to the model — that is the case the model
 * is there for.
 *
 * It reads the ROLE LABEL as well as the title, and the ORDER matters. American
 * Express posts every one of its internships as the single word "Apprentice",
 * so the title can never be settled and the description decides; on 16 Aug 2026
 * that put "Credit Risk Analyst" and a Financial Crimes Compliance role on an
 * engineering-only board. The model was following its prompt — the work does
 * run on SQL, Python and Tableau, and the prompt counts analytics as tech — so
 * the fix is the vocabulary, applied to the string that names the work.
 *
 * But the label only gets a say when the title has none. Labels name the
 * business domain as often as the work: BNP Paribas' "Data Science Intern" is
 * labelled "Financial NLP modelling", and `financial` is a negative term. A
 * label that could overrule a confident title would drop that to catch Amex.
 *
 * The real config is loaded rather than a fixture, so a term removed from
 * extraNonTechTerms fails here instead of silently going live.
 */
import { readFileSync } from 'node:fs';
import { vetoNonTech } from '../src/gemini.js';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${actual}\n         want: ${expected}`); }
}

console.log('\n== a title that settles nothing is decided by the label ==');
// Exactly the Amex shape: title says nothing, model says tech, label says risk.
check('Apprentice / Credit Risk Analyst', vetoNonTech('Apprentice', 'Credit Risk Analyst', true, cfg), false);
check('Apprentice / Credit and fraud risk', vetoNonTech('Apprentice', 'Credit and fraud risk', true, cfg), false);
check('Apprentice / Credit risk modelling', vetoNonTech('Apprentice', 'Credit risk modelling', true, cfg), false);
check('Apprentice / Market risk analytics', vetoNonTech('Apprentice Hiring for 2026- 2027', 'Market risk analytics', true, cfg), false);
check('Trainee / Underwriting Analyst', vetoNonTech('Graduate Trainee', 'Underwriting Analyst', true, cfg), false);

console.log('\n== a confident title outranks the label ==');
// The case that caught the first version of this fix: a real data science role
// whose label names the business domain, not the work.
check('Data Science Intern / Financial NLP modelling',
  vetoNonTech('Data Science Intern', 'Financial NLP modelling', true, cfg), true);
check('Software Engineer Intern / Payments compliance',
  vetoNonTech('Software Engineer Intern', 'Payments compliance analyst', true, cfg), true);
check('Risk Control Engineer Intern / Risk control analysis',
  vetoNonTech('Risk Control Engineer Intern', 'Risk control analysis', true, cfg), true);

console.log('\n== the title alone still vetoes ==');
check('Technical Support Representative', vetoNonTech('Technical Support Representative Intern', '', true, cfg), false);
check('a non-tech title beats a tech label',
  vetoNonTech('Technical Support Representative Intern', 'Backend engineering', true, cfg), false);

console.log('\n== engineering inside a risk team survives ==');
// A negative only wins when no multi-word positive also matches.
check('Apprentice / Credit Risk Data Engineer', vetoNonTech('Apprentice', 'Credit Risk Data Engineer', true, cfg), true);
check('Intern / Machine Learning Engineer', vetoNonTech('Intern', 'Machine Learning Engineer', true, cfg), true);

console.log('\n== the veto is one-way ==');
// The vocabulary being unsure must not promote OR demote — the model decides.
check('unsettled, model says tech', vetoNonTech('Apprentice', 'Rotational Programme', true, cfg), true);
check('unsettled, model says not', vetoNonTech('Apprentice', 'Rotational Programme', false, cfg), false);
check('no model verdict stays null', vetoNonTech('Apprentice', 'Rotational Programme', null, cfg), null);

console.log('\n== degenerate input ==');
check('empty label is ignored', vetoNonTech('Software Engineer Intern', '', true, cfg), true);
check('missing label is ignored', vetoNonTech('Software Engineer Intern', undefined, true, cfg), true);
check('empty title falls to the label', vetoNonTech('', 'Credit Risk Analyst', true, cfg), false);
check('both empty leaves the verdict', vetoNonTech('', null, true, cfg), true);
check('no config still classifies', vetoNonTech('Apprentice', 'Machine Learning Engineer', true), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
