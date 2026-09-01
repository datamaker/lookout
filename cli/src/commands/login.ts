import { input, password as passwordPrompt } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { api } from '../api.js';
import { clearAuth, getEmail, getToken, getUrl, saveGlobal } from '../config.js';
import { discover, pollForIdToken, startDeviceAuthorization, tryOpenBrowser } from '../sso.js';

export async function loginCommand(opts: {
  url?: string;
  email?: string;
  password?: string | boolean;
}): Promise<void> {
  const url = (
    opts.url ??
    (await input({
      message: 'lookout server URL',
      default: getUrl() ?? 'http://localhost:9000',
    }))
  ).replace(/\/+$/, '');

  // SSO (device flow) is the default whenever the server supports it;
  // --password forces the email/password prompt.
  if (opts.password === undefined && !opts.email) {
    const sso = await api.oidcStatus(url).catch(() => ({ enabled: false as const }));
    if (sso.enabled && 'issuer' in sso && sso.issuer && sso.cliClientId) {
      return ssoLogin(url, sso.issuer, sso.cliClientId);
    }
    if (sso.enabled) {
      console.log(
        chalk.yellow('SSO is enabled but the server is too old for CLI device flow; using password login.'),
      );
    }
  }

  const email = opts.email ?? (await input({ message: 'Email', default: getEmail() }));
  const password =
    typeof opts.password === 'string' ? opts.password : await passwordPrompt({ message: 'Password', mask: '*' });

  const { token, user } = await api.login(url, email, password);
  saveGlobal({ url, token, email: user.email });
  console.log(chalk.green(`✓ Logged in as ${user.name} <${user.email}> (${user.role})`));
  console.log(chalk.dim('  Token stored in ~/.config/lookout/config.json (valid 7 days)'));
}

async function ssoLogin(url: string, issuer: string, clientId: string): Promise<void> {
  let spinner = ora('Contacting SSO provider...').start();
  try {
    const discovery = await discover(issuer);
    const auth = await startDeviceAuthorization(discovery, clientId);
    spinner.stop();

    const verificationUrl = auth.verification_uri_complete ?? auth.verification_uri;
    console.log('\nOpen this URL in your browser to approve the login:\n');
    console.log(`  ${chalk.cyan(verificationUrl)}\n`);
    console.log(`Code: ${chalk.bold(auth.user_code)}\n`);
    tryOpenBrowser(verificationUrl);

    spinner = ora('Waiting for browser approval...').start();
    const idToken = await pollForIdToken(discovery, clientId, auth);

    spinner.text = 'Signing in to lookout...';
    const { token, user } = await api.exchangeIdToken(url, idToken);
    saveGlobal({ url, token, email: user.email });

    spinner.succeed(chalk.green(`Logged in as ${user.name} <${user.email}> (${user.role})`));
    console.log(chalk.dim('  Token stored in ~/.config/lookout/config.json (valid 7 days)'));
  } catch (err) {
    spinner.fail(chalk.red('SSO login failed'));
    console.error(chalk.red((err as Error).message));
    console.error(chalk.dim('Tip: `lookout login --password` uses email/password instead.'));
    process.exitCode = 1;
  }
}

export function logoutCommand(): void {
  clearAuth();
  console.log(chalk.green('✓ Logged out'));
}

export async function whoamiCommand(): Promise<void> {
  const url = getUrl();
  if (!url || !getToken()) {
    console.log(chalk.yellow('Not logged in. Run `lookout login`.'));
    process.exitCode = 1;
    return;
  }
  const { user } = await api.me();
  console.log(`${chalk.bold(user.name)} <${user.email}> (${user.role})`);
  console.log(chalk.dim(`Server: ${url}`));
}
