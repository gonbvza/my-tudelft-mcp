import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { request, type Browser } from 'playwright';
import { load, type CheerioAPI } from 'cheerio';
import { runLoginFlow } from './login-flow.js';
import type { Auth, BrowserState } from './auth.js';
import type { BrightspaceClient } from './client.js';
import { BrightspaceError, safeError } from './errors.js';
import { Vault } from './vault.js';
import { plainText, record, sleep, str, type Row } from './util.js';

/**
 * WebLab (weblab.tudelft.nl) has no public API. Every read parses its
 * server-rendered pages with the student's own session. Read-only: no tool
 * saves, submits, re-opens or runs anything on WebLab.
 */
export const WEBLAB_ORIGIN = 'https://weblab.tudelft.nl';
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_TREE_NODES = 600;
const MAX_TREE_DEPTH = 8;
const REQUEST_GAP_MS = 400;
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const EDITION = /^[0-9]{4}-[0-9]{4}$/;
const NUMERIC = /^[0-9]{1,12}$/;
const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
type Cookie = BrowserState['cookies'][number];
type Client = Pick<BrightspaceClient, 'config' | 'json' | 'sessionIdentity'>;

interface Session {
  version: 1; brightspaceOrigin: string; accountId: string; username: string; cookies: Cookie[]; savedAt: string;
}
export interface WebLabLoginStatus { state: 'idle' | 'waiting' | 'connected' | 'failed'; message: string; error?: ReturnType<typeof safeError> }
export interface CourseRef { course: string; edition: string }

export interface AssignmentChild { id: string; title: string; kind: string; weight?: string; due?: string }
export interface AssignmentPage {
  id: string; title: string; kind?: string; parentId?: string; submissionId?: string;
  info: Record<string, string>; description: string; files: Array<{ name: string; url: string }>; children: AssignmentChild[];
}
export interface SubmissionPage {
  status?: string; info: Record<string, string>; editors: Record<string, string>; specTests?: string;
}

function webLabCookies(cookies: Cookie[]): Cookie[] {
  return cookies.filter(cookie => cookie.domain.replace(/^\./, '') === 'weblab.tudelft.nl' && cookie.secure
    && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
}
function clean(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
/** Tooltip text: plain HTTP serves title=; the browser's Bootstrap moves it to data-original-title. */
function tooltip(node: ReturnType<CheerioAPI>): string { return clean(node.attr('data-original-title') || node.attr('title') || ''); }
export function courseRef(course: string, edition: string): CourseRef {
  const c = course.trim().toLowerCase(), e = edition.trim();
  if (!SLUG.test(c) || !EDITION.test(e)) throw new BrightspaceError('INVALID_ID', 'Use the exact WebLab course slug (e.g. cs4510) and edition (e.g. 2026-2027) from weblab_list_courses.');
  return { course: c, edition: e };
}
function numeric(value: string, what = 'assignment'): string {
  if (!NUMERIC.test(value)) throw new BrightspaceError('INVALID_ID', `Use an exact numeric WebLab ${what} ID from another WebLab tool.`);
  return value;
}
const editionBase = (ref: CourseRef): string => `${WEBLAB_ORIGIN}/${ref.course}/${ref.edition}`;

/** The signed-in WebLab username, read from the account menu's own profile link. */
export function signedInUser($: CheerioAPI): string | undefined {
  let user: string | undefined;
  $('a[href]').each((_, a) => {
    const match = /^https:\/\/weblab\.tudelft\.nl\/profile\/([^/?#]+)\/?$/.exec($(a).attr('href') ?? '');
    if (match && /my profile/i.test($(a).text())) { user = decodeURIComponent(match[1]!).toLowerCase(); return false; }
    return undefined;
  });
  return user && USERNAME.test(user) ? user : undefined;
}

/** Courses in the student's own "recent courses" panel. The rest of the home page lists public courses. */
export function parseCourses(html: string): Array<CourseRef & { code?: string; title: string; url: string }> {
  const $ = load(html), seen = new Map<string, CourseRef & { code?: string; title: string; url: string }>();
  $('.recent-courses-scrollable a[href]').each((_, a) => {
    const match = /^https:\/\/weblab\.tudelft\.nl\/([a-z0-9-]+)\/([0-9]{4}-[0-9]{4})\/?$/.exec($(a).attr('href') ?? '');
    if (!match) return;
    const url = `${WEBLAB_ORIGIN}/${match[1]}/${match[2]}/`;
    const title = clean($(a).find('.title').first().text()) || clean($(a).text());
    const code = clean($(a).find('.code').first().text()) || undefined;
    if (!seen.has(url)) seen.set(url, { course: match[1]!, edition: match[2]!, code, title, url });
  });
  return [...seen.values()];
}

/** The course edition's root assignment collection ("Assignments" in its menu). */
export function parseCourseRoot(html: string, ref: CourseRef): { title: string; rootId: string; announcements: Array<{ title: string; text: string }> } {
  const $ = load(html), prefix = `${editionBase(ref)}/assignment/`;
  let rootId: string | undefined;
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    if (href.startsWith(prefix) && clean($(a).text()) === 'Assignments') {
      const id = /^(\d+)\/?$/.exec(href.slice(prefix.length))?.[1];
      if (id) { rootId = id; return false; }
    }
    return undefined;
  });
  if (!rootId) throw new BrightspaceError('WEBLAB_FORMAT_CHANGED', 'The WebLab course page did not link its assignment collection.');
  const title = clean($('title').text()).replace(/^[^:]*:\s*/, '');
  const announcements: Array<{ title: string; text: string }> = [];
  $('.announcement, .news-item, .announcements .item').slice(0, 10).each((_, item) => {
    const heading = clean($(item).find('h3,h4,h5,strong').first().text());
    announcements.push({ title: heading, text: plainText($(item).html() ?? '').slice(0, 4000) });
  });
  return { title, rootId, announcements };
}

function infoRows($: CheerioAPI): Record<string, string> {
  const info: Record<string, string> = {};
  $('tr.infoRow').each((_, row) => {
    const label = clean($(row).find('.infoRowLabel').text());
    const value = $(row).find('.infoRowValue').clone();
    value.find('.text-muted,script,input,.tz-info').remove();
    const text = clean(value.text());
    // "Submission of" carries a name and a tooltip with netid/student number; keep identifiers out.
    if (!text || ['Assignment Link', 'Submission of'].includes(label)) return;
    info[label || 'State'] = text.slice(0, 300);
  });
  return info;
}

export function parseAssignment(html: string, ref: CourseRef, id: string): AssignmentPage {
  const $ = load(html), base = `${editionBase(ref)}/assignment/`;
  const title = clean($('title').text()).replace(/^✎\s*/, '').replace(/\s+-\s+[^-]+$/, '');
  if (!title || !$('tr.infoRow').length) throw new BrightspaceError('WEBLAB_FORMAT_CHANGED', 'The WebLab assignment page was not recognised.');
  const children: AssignmentChild[] = [];
  $('table.assignment-table tbody tr.majorrow').each((_, row) => {
    const link = $(row).find('a.assignment-link').first();
    const childId = /^(\d+)\/info$/.exec((link.attr('href') ?? '').slice(base.length))?.[1];
    if (!childId || !(link.attr('href') ?? '').startsWith(base)) return;
    const cells = $(row).find('td');
    const deadline = $(row).find('.deadline-in-table').clone();
    deadline.find('.tz-info').remove();
    deadline.find('br').replaceWith(' ');
    children.push({ id: childId, title: clean(link.text()),
      kind: tooltip($(cells[0]).find('[data-original-title],[title]').first()) || 'unknown',
      weight: clean($(cells[2]).clone().find('small').remove().end().text()) || undefined,
      due: clean(deadline.text()) || undefined });
  });
  const parentHref = $('table.assignment-table thead a[href]').first().attr('href')
    ?? $('a[href]').filter((_, a) => clean($(a).text()) === '..').first().attr('href') ?? '';
  const parentId = /^(\d+)\/info$/.exec(parentHref.slice(base.length))?.[1];
  const submissionId = $('a[href]').map((_, a) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${id}/submission/(\\d+)/$`).exec($(a).attr('href') ?? '')?.[1]).get().find(Boolean);
  const files: Array<{ name: string; url: string }> = [];
  $('a[href]').each((_, a) => {
    const match = /^https:\/\/weblab\.tudelft\.nl\/getFile\/(\d+)\/([A-Za-z0-9._-]{1,120})$/.exec($(a).attr('href') ?? '');
    if (match && match[1] === id && !files.some(file => file.name === match[2])) files.push({ name: match[2]!, url: match[0] });
  });
  const descriptionNode = $('.assignment-info .assignment-text').first();
  const description = descriptionNode.length ? plainText(descriptionNode.html() ?? '') : '';
  const kind = $('[data-original-title],[title]').map((_, e) => tooltip($(e))).get()
    .find(text => /question|collection of assignments/i.test(text) && !/^collection:/i.test(text));
  return { id, title, kind: children.length ? 'Collection of Assignments' : kind, parentId, submissionId, info: infoRows($),
    description: description.slice(0, 60_000), files, children };
}

export function parseSubmission(html: string): SubmissionPage {
  const $ = load(html);
  if (!$('tr.infoRow').length) throw new BrightspaceError('WEBLAB_FORMAT_CHANGED', 'The WebLab submission page was not recognised.');
  const editors: Record<string, string> = {};
  $('textarea.inputTextarea').each((index, area) => {
    const pane = $(area).closest('.tab-pane'), paneId = pane.attr('id');
    const label = paneId ? clean($('a[href]').filter((_, a) => $(a).attr('href') === '#' + paneId).first().text()) : '';
    editors[label || `editor${index + 1}`] = $(area).text().slice(0, 500_000);
  });
  const info = infoRows($);
  const specTests = clean($('.spectest-attempts').first().text()) || undefined;
  return { status: info.State, info, editors, specTests };
}

function slugify(title: string): string {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}

export class WebLab {
  private loginState: WebLabLoginStatus = { state: 'idle', message: 'Run weblab_begin_login (or silent weblab_check_auth after connecting once) to connect WebLab.' };
  private generation = 0;
  private loginTask?: Promise<void>;
  private browser?: Browser;
  private renewing?: Promise<void>;
  private failedSilentAt = 0;
  constructor(private readonly auth: Auth, private readonly client: Client) {}

  status(): WebLabLoginStatus { return structuredClone(this.loginState); }
  private vault(accountId: string): Vault<Session> { return new Vault(this.auth.config.dataDir, 'weblab-' + digest(this.auth.config.baseUrl + ':' + accountId).slice(0, 20)); }

  /** The Brightspace account and its NetID; WebLab usernames are TU Delft NetIDs. */
  private async identity(): Promise<{ accountId: string; netId: string }> {
    if (this.auth.config.baseUrl !== 'https://brightspace.tudelft.nl') throw new BrightspaceError('WEBLAB_IDENTITY_UNVERIFIED', 'WebLab access is verified only against TU Delft Brightspace.');
    const accountId = await this.client.sessionIdentity();
    if (!accountId) throw new BrightspaceError('AUTH_REQUIRED', 'Verify your Brightspace account before connecting WebLab.');
    const me = record(await this.client.json('lp', 'users/whoami'));
    if (str(me.Identifier) !== accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed before WebLab access.');
    const netId = str(me.UniqueName).trim().toLowerCase().replace(/@(student\.)?tudelft\.nl$/, '');
    if (!USERNAME.test(netId)) throw new BrightspaceError('WEBLAB_IDENTITY_UNVERIFIED', 'Brightspace did not supply a NetID to compare with WebLab.');
    return { accountId, netId };
  }

  async beginLogin(options: { silent?: boolean } = {}): Promise<WebLabLoginStatus> {
    if (this.loginTask) return this.status();
    const generation = this.generation, expected = await this.identity();
    this.loginState = { state: 'waiting', message: options.silent ? 'Reconnecting WebLab through your shared TU Delft sign-in.'
      : 'Opening WebLab TU Delft Single Sign-On. Complete sign-in or MFA in the browser only if the university asks.' };
    this.loginTask = this.login(expected, generation, options.silent === true).catch((error: unknown) => {
      this.loginState = { state: 'failed', message: error instanceof BrightspaceError ? error.message : 'The WebLab login could not finish.', error: safeError(error) };
    }).finally(() => { this.loginTask = undefined; });
    return this.status();
  }
  async waitForLogin(): Promise<WebLabLoginStatus> { await this.loginTask; return this.status(); }

  private async login(expected: { accountId: string; netId: string }, generation: number, silent: boolean): Promise<void> {
    const vault = this.vault(expected.accountId), fingerprint = await vault.fingerprint(), previous = await vault.load();
    const shared = await this.auth.sso(expected.accountId);
    const saved = previous?.version === 1 && previous.accountId === expected.accountId ? webLabCookies(previous.cookies) : [];
    if (silent && !shared.cookies.length && !saved.length) throw new BrightspaceError('WEBLAB_AUTH_REQUIRED', 'WebLab needs one interactive sign-in. Run weblab_begin_login when the student asks.');
    const check = async (): Promise<void> => {
      if (generation !== this.generation) throw new BrightspaceError('WEBLAB_SESSION_CHANGED', 'The WebLab connection was closed or changed.');
      if (await this.client.sessionIdentity() !== expected.accountId) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed during WebLab sign-in.');
    };
    try {
      await runLoginFlow<true>({
        silent, channel: this.auth.config.browserChannel, isolate: true,
        storageState: { cookies: [...shared.cookies, ...saved], origins: [] },
        contextOptions: { locale: 'en-GB', timezoneId: 'Europe/Amsterdam' },
        errors: {
          cancelled: { code: 'WEBLAB_LOGIN_CANCELLED', message: 'The WebLab login browser was closed.' },
          timeout: { code: 'WEBLAB_LOGIN_TIMEOUT', message: 'The WebLab login timed out. Run weblab_begin_login again.' },
          authRequired: { code: 'WEBLAB_AUTH_REQUIRED', message: 'The university needs sign-in or MFA for WebLab. Run weblab_begin_login when the student asks.' },
        },
        onBrowser: launched => { this.browser = launched; },
        check,
        start: async page => { await page.goto(WEBLAB_ORIGIN + '/samlsignin', { waitUntil: 'domcontentloaded', timeout: this.auth.config.timeoutMs }); },
        probe: async (page, context) => {
          const url = new URL(page.url());
          if (url.origin !== WEBLAB_ORIGIN || /signin/i.test(url.pathname)) return undefined;
          const user = signedInUser(load(await page.content()));
          if (!user) return undefined;
          if (user !== expected.netId) throw new BrightspaceError('WEBLAB_ACCOUNT_MISMATCH', 'The WebLab account does not match the current Brightspace NetID. Sign in with the same TU Delft account.');
          await check();
          const storage = await context.storageState();
          await vault.save({ version: 1, brightspaceOrigin: this.auth.config.baseUrl, accountId: expected.accountId, username: user,
            cookies: webLabCookies(storage.cookies), savedAt: new Date().toISOString() }, fingerprint, () => {
            if (generation !== this.generation || page.isClosed()) throw new BrightspaceError('WEBLAB_LOGIN_CANCELLED', 'The WebLab login was cancelled before saving.');
          });
          await shared.save(storage.cookies, () => {
            if (generation !== this.generation) throw new BrightspaceError('WEBLAB_LOGIN_CANCELLED', 'The WebLab login was cancelled before saving shared sign-in.');
          });
          this.failedSilentAt = 0;
          this.loginState = { state: 'connected', message: 'WebLab is connected and matched to your Brightspace NetID.' };
          return true;
        },
      });
    } finally { this.browser = undefined; }
  }

  private async session(): Promise<{ session: Session; netId: string }> {
    const expected = await this.identity(), session = await this.vault(expected.accountId).load();
    if (!session || session.version !== 1 || session.brightspaceOrigin !== this.auth.config.baseUrl || session.accountId !== expected.accountId
      || !Array.isArray(session.cookies) || session.username !== expected.netId) {
      throw new BrightspaceError('WEBLAB_AUTH_REQUIRED', 'Run weblab_begin_login to connect WebLab.');
    }
    return { session, netId: expected.netId };
  }

  private async renew(): Promise<void> {
    if (this.renewing) return this.renewing;
    if (Date.now() - this.failedSilentAt < 60_000) throw new BrightspaceError('WEBLAB_AUTH_REQUIRED', 'Automatic WebLab reconnection could not complete. Run weblab_begin_login if the university needs sign-in or MFA.');
    this.renewing = (async () => {
      await this.beginLogin({ silent: true }); await this.loginTask;
      if (this.loginState.state !== 'connected') {
        this.failedSilentAt = Date.now();
        throw new BrightspaceError(this.loginState.error?.code ?? 'WEBLAB_AUTH_REQUIRED', this.loginState.error?.message ?? 'Run weblab_begin_login to reconnect WebLab.');
      }
    })().finally(() => { this.renewing = undefined; });
    return this.renewing;
  }

  /** One bounded read with the saved cookies. Redirects (sign-in) are never followed. */
  private async fetch(url: string, allowRenew = true): Promise<{ body: Buffer; html?: CheerioAPI }> {
    const target = new URL(url);
    if (target.origin !== WEBLAB_ORIGIN || target.username || target.password) throw new BrightspaceError('EXTERNAL_RESOURCE', 'Only weblab.tudelft.nl pages are read with the WebLab session.');
    const { session, netId } = await this.session();
    const context = await request.newContext({ storageState: { cookies: session.cookies, origins: [] }, timeout: this.auth.config.timeoutMs });
    try {
      const response = await context.get(target.href, { maxRedirects: 0, maxRetries: 0 });
      const status = response.status();
      if (status >= 300 && status < 400 || status === 401) {
        await response.dispose();
        if (!allowRenew) throw new BrightspaceError('WEBLAB_AUTH_REQUIRED', 'The WebLab session expired. Run weblab_begin_login when the student asks.');
        await this.renew(); return this.fetch(url, false);
      }
      if (status === 403) throw new BrightspaceError('WEBLAB_PERMISSION_DENIED', 'WebLab did not permit this read.');
      if (status === 404) throw new BrightspaceError('WEBLAB_NOT_FOUND', 'The WebLab page was not found.');
      if (!response.ok()) throw new BrightspaceError('WEBLAB_UNAVAILABLE', 'WebLab returned an error.', { status });
      const body = await response.body();
      if (body.length > MAX_PAGE_BYTES) throw new BrightspaceError('WEBLAB_LIMIT', 'The WebLab response exceeded its read limit.');
      if (!(response.headers()['content-type'] ?? '').includes('text/html')) return { body };
      const $ = load(body.toString('utf8')), user = signedInUser($);
      if (!user) {
        if (!allowRenew) throw new BrightspaceError('WEBLAB_AUTH_REQUIRED', 'The WebLab session expired. Run weblab_begin_login when the student asks.');
        await this.renew(); return this.fetch(url, false);
      }
      if (user !== netId) throw new BrightspaceError('WEBLAB_ACCOUNT_MISMATCH', 'WebLab is signed in to a different account. Run weblab_logout, then weblab_begin_login.');
      return { body, html: $ };
    } finally { await context.dispose(); }
  }
  private async page(url: string): Promise<string> {
    const { body, html } = await this.fetch(url);
    if (!html) throw new BrightspaceError('WEBLAB_FORMAT_CHANGED', 'WebLab did not return a page.');
    return body.toString('utf8');
  }

  async checkAuth(): Promise<Row> {
    await this.page(WEBLAB_ORIGIN + '/');
    return { connected: true, provider: 'WebLab', accountVerified: true, identityMethod: 'netid' };
  }
  async courses(): Promise<Row> {
    const items = parseCourses(await this.page(WEBLAB_ORIGIN + '/'));
    return { source: 'weblab_html', sourceUrl: WEBLAB_ORIGIN + '/', items, coverage: 'Courses in your WebLab "recent courses" panel.', fetchedAt: new Date().toISOString() };
  }
  async course(course: string, edition: string): Promise<Row> {
    const ref = courseRef(course, edition), url = editionBase(ref) + '/';
    return { ...ref, sourceUrl: url, ...parseCourseRoot(await this.page(url), ref), fetchedAt: new Date().toISOString() };
  }
  async assignment(course: string, edition: string, assignmentId?: string): Promise<Row> {
    const ref = courseRef(course, edition);
    const id = assignmentId ? numeric(assignmentId) : parseCourseRoot(await this.page(editionBase(ref) + '/'), ref).rootId;
    const url = `${editionBase(ref)}/assignment/${id}/info`;
    const parsed = parseAssignment(await this.page(url), ref, id);
    return { ...ref, sourceUrl: url, ...parsed, submissionId: undefined, hasSubmissionPage: Boolean(parsed.submissionId), fetchedAt: new Date().toISOString() };
  }
  async submission(course: string, edition: string, assignmentId: string): Promise<Row> {
    const ref = courseRef(course, edition), id = numeric(assignmentId);
    const info = parseAssignment(await this.page(`${editionBase(ref)}/assignment/${id}/info`), ref, id);
    if (!info.submissionId) throw new BrightspaceError('WEBLAB_NOT_FOUND', 'This WebLab assignment has no submission page for your account.');
    const url = `${editionBase(ref)}/assignment/${id}/submission/${info.submissionId}/`;
    return { ...ref, assignmentId: id, title: info.title, sourceUrl: url, ...parseSubmission(await this.page(url)), readOnly: true, fetchedAt: new Date().toISOString() };
  }

  /** Walk an assignment tree and save each exercise's description and published files (e.g. assignment.v). */
  async downloadExercises(course: string, edition: string, outputDir: string, options: { assignmentId?: string; includeMySolutions?: boolean } = {}): Promise<Row> {
    const ref = courseRef(course, edition);
    if (!isAbsolute(outputDir)) throw new BrightspaceError('INVALID_PATH', 'Use an absolute output directory.');
    const root = resolve(outputDir);
    const rootId = options.assignmentId ? numeric(options.assignmentId) : parseCourseRoot(await this.page(editionBase(ref) + '/'), ref).rootId;
    const saved: Array<{ assignmentId: string; path: string; files: string[] }> = [], failed: Array<{ assignmentId: string; error: ReturnType<typeof safeError> }> = [];
    const queue: Array<{ id: string; dir: string; depth: number; index?: number }> = [{ id: rootId, dir: root, depth: 0 }];
    let visited = 0, truncated = false;
    while (queue.length) {
      if (visited >= MAX_TREE_NODES) { truncated = true; break; }
      const node = queue.shift()!; visited++;
      let page: AssignmentPage;
      try {
        if (visited > 1) await sleep(REQUEST_GAP_MS);
        page = parseAssignment(await this.page(`${editionBase(ref)}/assignment/${node.id}/info`), ref, node.id);
      } catch (error) {
        if (error instanceof BrightspaceError && /AUTH|MISMATCH|ACCOUNT/.test(error.code)) throw error;
        failed.push({ assignmentId: node.id, error: safeError(error) }); continue;
      }
      const name = (node.index === undefined ? '' : String(node.index).padStart(2, '0') + '-') + slugify(page.title);
      const dir = node.depth === 0 ? root : join(node.dir, name);
      if (page.children.length) {
        if (node.depth >= MAX_TREE_DEPTH) { truncated = true; continue; }
        page.children.forEach((child, index) => queue.push({ id: child.id, dir, depth: node.depth + 1, index: index + 1 }));
        continue;
      }
      try {
        await mkdir(dir, { recursive: true });
        const written: string[] = [];
        const readme = [`# ${page.title}`, '', `Source: ${editionBase(ref)}/assignment/${page.id}/info`, '',
          ...(page.kind ? [`- **Type:** ${page.kind}`] : []),
          ...Object.entries(page.info).map(([key, value]) => `- **${key}:** ${value}`), '', page.description, ''].join('\n');
        await writeFile(join(dir, 'README.md'), readme); written.push('README.md');
        for (const file of page.files) {
          await sleep(REQUEST_GAP_MS);
          const { body } = await this.fetch(file.url);
          if (body.length > this.auth.config.maxFileBytes) throw new BrightspaceError('WEBLAB_LIMIT', 'A WebLab file exceeded the download limit.');
          await writeFile(join(dir, file.name), body); written.push(file.name);
        }
        if (options.includeMySolutions && page.submissionId) {
          await sleep(REQUEST_GAP_MS);
          const submission = parseSubmission(await this.page(`${editionBase(ref)}/assignment/${page.id}/submission/${page.submissionId}/`));
          const solution = submission.editors.Solution;
          if (solution?.trim()) { await writeFile(join(dir, 'my-solution' + (page.files[0]?.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.txt')), solution); written.push('my-solution'); }
        }
        saved.push({ assignmentId: page.id, path: dir, files: written });
      } catch (error) {
        if (error instanceof BrightspaceError && /AUTH|MISMATCH|ACCOUNT/.test(error.code)) throw error;
        failed.push({ assignmentId: page.id, error: safeError(error) });
      }
    }
    return { ...ref, rootId, outputDir: root, exercises: saved.length, saved, failed, visited, truncated, complete: !truncated && !failed.length && !queue.length,
      note: 'Read-only: nothing was saved, submitted or run on WebLab.', fetchedAt: new Date().toISOString() };
  }

  async close(): Promise<void> {
    this.generation++;
    await this.browser?.close().catch(() => undefined);
    await this.loginTask;
    this.loginState = { state: 'idle', message: 'The WebLab connection is closed. Saved access is verified on the next read.' };
  }
  async logout(): Promise<void> {
    const account = await this.client.sessionIdentity().catch(() => undefined);
    await this.close();
    if (account) await this.vault(account).clear();
    this.loginState = { state: 'idle', message: 'The local WebLab login has been removed.' };
  }
}
