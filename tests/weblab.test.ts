import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from 'cheerio';
import { courseRef, parseAssignment, parseCourseRoot, parseCourses, parseSubmission, questionMarkdown, signedInUser } from '../src/weblab.js';

// Synthetic fixtures shaped like WebLab's server-rendered markup. No real student data.
const ref = { course: 'cs0000', edition: '2026-2027' };
const base = 'https://weblab.tudelft.nl/cs0000/2026-2027';
const header = '<a href="https://weblab.tudelft.nl/profile/student1">My Profile</a><a href="https://weblab.tudelft.nl/profile/student1/edit">My Account</a>';
const row = (label: string, value: string) => `<tr class="infoRow"><td class="infoRowLabel">${label}</td><td class="infoRowValue">${value}</td></tr>`;
const info = row('Assignment Link', '<input value="x">') + row('Available on ', '<span>Mon, Sep 1, 2026 09:00:00 <span class="tz-info">tz</span></span>')
  + row('Weight', '1.0<small class="text-muted"> of total 3.0</small>') + row('Due', 'Fri, Sep 4, 2026 18:00:00<div class="text-muted"> advised</div>')
  + row('Deadline', 'No deadline<br><span class="text-muted">A personal deadline may be set</span>');

test('signed-in user comes from the account menu profile link only', () => {
  assert.equal(signedInUser(load(header)), 'student1');
  assert.equal(signedInUser(load('<a href="https://weblab.tudelft.nl/profile/other">Someone</a>')), undefined);
  assert.equal(signedInUser(load('<a href="https://evil.example/profile/student1">My Profile</a>')), undefined);
});

test('course list uses the recent-courses panel and ignores public listings', () => {
  const html = `<div class="recent-courses-scrollable"><a href="${base}/"><span class="edition">2026-2027</span><span class="code">CS0000</span><span class="title">Example Course</span></a><a href="${base}/">dup</a></div><div class="page-content"><a href="https://weblab.tudelft.nl/public1/2026-2027/">Public</a></div>`;
  assert.deepEqual(parseCourses(html), [{ ...ref, code: 'CS0000', title: 'Example Course', url: base + '/' }]);
});

test('course root is the Assignments menu link of the same edition', () => {
  const html = `<title>CS0000: Example Course</title><a href="https://weblab.tudelft.nl/other/2026-2027/assignment/9/">Assignments</a><a href="${base}/assignment/100/">Assignments</a>`;
  assert.equal(parseCourseRoot(html, ref).rootId, '100');
  assert.throws(() => parseCourseRoot('<title>x</title>', ref), { code: 'WEBLAB_FORMAT_CHANGED' });
});

test('collection pages list children with kind, weight and due date', () => {
  const html = `<title>Week 1 - CS0000</title><table>${info}</table><table class="table assignment-table"><thead><tr><th><a href="${base}/assignment/100/info">..</a></th></tr></thead><tbody>
    <tr class="majorrow"><td><span title="Programming question (coq)"></span></td><td><a href="${base}/assignment/201/info" class="assignment-link">Exercise one</a></td><td>1.0<small> of total 2.0</small></td><td></td><td><span class="deadline-in-table"><strong>Sep 4</strong><br>18:00 <span class="tz-info">tz</span></span></td></tr>
    <tr class="majorrow"><td><span data-original-title="Collection of Assignments"></span></td><td><a href="https://evil.example/assignment/202/info" class="assignment-link">Elsewhere</a></td></tr>
  </tbody></table>`;
  const page = parseAssignment(html, ref, '150');
  assert.equal(page.title, 'Week 1');
  assert.equal(page.parentId, '100');
  assert.deepEqual(page.children, [{ id: '201', title: 'Exercise one', kind: 'Programming question (coq)', weight: '1.0', due: 'Sep 4 18:00' }]);
  assert.equal(page.info.Due, 'Fri, Sep 4, 2026 18:00:00');
  assert.equal(page.info['Assignment Link'], undefined);
});

test('exercise pages expose description, own submission link and only their own files', () => {
  const html = `<title>Prove it - CS0000</title><table>${info}</table>
    <a href="${base}/assignment/201/submission/555/">Open your submission</a>
    <a href="https://weblab.tudelft.nl/getFile/201/assignment.v">download</a><a href="https://weblab.tudelft.nl/getFile/999/other.v">other</a><a href="https://weblab.tudelft.nl/getFile/201/../x">bad</a>
    <div class="assignment-info"><div class="assignment-text"><p>Prove that</p><pre><code>Theorem t : True.</code></pre><script>ignore()</script></div></div>`;
  const page = parseAssignment(html, ref, '201');
  assert.equal(page.submissionId, '555');
  assert.deepEqual(page.files, [{ name: 'assignment.v', url: 'https://weblab.tudelft.nl/getFile/201/assignment.v' }]);
  assert.match(page.description, /Prove that/);
  assert.match(page.description, /Theorem t : True\./);
  assert.doesNotMatch(page.description, /ignore/);
  assert.throws(() => parseAssignment('<title>Sign in</title>', ref, '201'), { code: 'WEBLAB_FORMAT_CHANGED' });
});

test('submission pages map editors to their tab labels and drop identity tooltips', () => {
  const html = `<table>${row('Submission of', '<a data-original-title="netid:student1 studnr:123">Student</a>')}${row('', 'Completed')}${row('Last saved', 'Tue, Sep 1, 2026')}</table>
    <ul><li><a href="#p1" data-toggle="tab">Solution</a></li><li><a href="#p2" data-toggle="tab">Test</a></li></ul>
    <div class="tab-content"><div class="tab-pane" id="p1"><textarea class="inputTextarea">Proof. auto. Qed.</textarea></div><div class="tab-pane" id="p2"><textarea class="inputTextarea"></textarea></div></div>`;
  const sub = parseSubmission(html);
  assert.equal(sub.status, 'Completed');
  assert.deepEqual(sub.editors, { Solution: 'Proof. auto. Qed.', Test: '' });
  assert.doesNotMatch(JSON.stringify(sub), /studnr|netid|123/);
});

test('course references are validated before any request', () => {
  assert.deepEqual(courseRef(' CS0000 ', '2026-2027'), ref);
  for (const [c, e] of [['../x', '2026-2027'], ['cs0000', '2026'], ['cs0000', '2026-2027/../']]) assert.throws(() => courseRef(c, e), { code: 'INVALID_ID' });
});

test('multiple-choice panels yield stem and options; answers only on request', () => {
  const html = `<table>${row('', 'Completed')}</table><div class="panel question-element"><div class="panel-body"><span class="pull-right">weight: 1.0</span><h3>Example</h3>
    <div class="collapse-pane open"><div class="wikitext"><p>Why does <code>t</code> hold?</p><pre>Lemma t : True.\nProof.\n  exact I.\nQed.</pre></div><div class="open-control"><a>expand</a><a>collapse</a></div></div></div>
    <div class="panel-footer"><p>Select one option</p>
      <label class="radio"><input type="radio" name="q" value="a"><div class="mcq-feedback text-muted"><div class="wikitext"><p>Option A</p></div></div></label>
      <label class="radio"><input type="radio" checked="checked" name="q" value="b"><div class="mcq-feedback bg-success"><div class="wikitext"><p>Option <code>B</code></p></div></div></label>
      <div class="text-muted">true Submitted answer is correct</div></div></div>`;
  const [question] = parseSubmission(html).questions;
  assert.equal(question?.title, 'Example');
  assert.equal(question?.text, 'Why does `t` hold?\n\n```\nLemma t : True.\nProof.\n  exact I.\nQed.\n```');
  assert.deepEqual(question?.options, [{ text: 'Option A' }, { text: 'Option `B`', selected: true, feedback: 'correct' }]);
  const plain = questionMarkdown(question!, false), answered = questionMarkdown(question!, true);
  assert.match(plain, /- \[ \] Option `B`\n/);
  assert.doesNotMatch(plain, /correct|\[x\]/);
  assert.match(answered, /- \[x\] Option `B` _\(correct\)_/);
  assert.match(answered, /Your result:\*\* Submitted answer is correct/);
});
