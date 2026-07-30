<?php

declare(strict_types=1);

namespace OCA\RegiBase\Command;

use OCA\RegiBase\AppInfo\Application;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Question\Question;

/**
 * Manage a user's encryption master key from the CLI — the server-side mirror of
 * the app's Set / Change / Remove master-key actions. Secret fields are encrypted
 * client-side normally; these operations re-derive the key from a password given
 * on the command line (never stored) and re-write the affected records.
 *
 *   occ regibase:master status  --user=UID
 *   occ regibase:master set     --user=UID   (--new-password / REGIBASE_NEW_PASSWORD)
 *   occ regibase:master change  --user=UID   (--password + --new-password)
 *   occ regibase:master remove  --user=UID   (--password)   -> decrypt to plain text
 */
class MasterKey extends Base {
	private const PREFIX = 'rbenc1:';

	protected function configure(): void {
		$this->setName('regibase:master')
			->setDescription('Manage the encryption master key: status | set | change | remove')
			->addArgument('action', InputArgument::REQUIRED, 'status | set | change | remove')
			->addOption('user', 'u', InputOption::VALUE_REQUIRED, 'User id (required)')
			->addOption('password', null, InputOption::VALUE_REQUIRED, 'Current master key (or REGIBASE_PASSWORD env)')
			->addOption('new-password', null, InputOption::VALUE_REQUIRED, 'New master key (or REGIBASE_NEW_PASSWORD env)')
			->addOption('yes', 'y', InputOption::VALUE_NONE, 'Skip the confirmation prompt (for remove)');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$uid = $input->getOption('user');
		if (!is_string($uid) || $uid === '') {
			$output->writeln('<error>--user is required.</error>');
			return 1;
		}
		$action = (string)$input->getArgument('action');
		$app = Application::APP_ID;
		$enabled = $this->config->getUserValue($uid, $app, 'enc_enabled', '0') === '1';
		$salt = $this->config->getUserValue($uid, $app, 'enc_salt', '');
		$verifier = $this->config->getUserValue($uid, $app, 'enc_verifier', '');

		switch ($action) {
			case 'status':
				$output->writeln('Encryption: ' . ($enabled ? '<info>enabled</info>' : '<comment>disabled</comment>'));
				$output->writeln('Salt set:    ' . ($salt !== '' ? 'yes' : 'no'));
				$output->writeln('Verifier:    ' . ($verifier !== '' ? 'yes' : 'no'));
				return 0;

			case 'set':
				if ($enabled) {
					$output->writeln('<error>Encryption is already enabled. Use "change" to re-key, or "remove" first.</error>');
					return 1;
				}
				$new = $this->askPassword($input, $output, 'new-password', 'REGIBASE_NEW_PASSWORD', 'New master key');
				if (mb_strlen($new) < 6) {
					$output->writeln('<error>Master key must be at least 6 characters.</error>');
					return 1;
				}
				$newSalt = base64_encode(random_bytes(16));
				$newKey = $this->derive($new, $newSalt);
				$res = $this->sweep($uid, function (string $v) use ($newKey): array {
					return $this->isEnc($v) ? [null, true] : [$this->enc($newKey, $v), true];
				});
				$this->config->setUserValue($uid, $app, 'enc_salt', $newSalt);
				$this->config->setUserValue($uid, $app, 'enc_verifier', $this->enc($newKey, 'regibase-ok'));
				$this->config->setUserValue($uid, $app, 'enc_enabled', '1');
				$output->writeln(sprintf('<info>Encryption enabled.</info> Encrypted %d value(s) in %d record(s).', $res['values'], $res['records']));
				return 0;

			case 'change':
				if (!$enabled || $salt === '' || $verifier === '') {
					$output->writeln('<error>Encryption is not set up. Use "set".</error>');
					return 1;
				}
				$cur = $this->askPassword($input, $output, 'password', 'REGIBASE_PASSWORD', 'Current master key');
				$oldKey = $this->derive($cur, $salt);
				if ($this->dec($oldKey, $verifier) !== 'regibase-ok') {
					$output->writeln('<error>Wrong current master key.</error>');
					return 1;
				}
				$new = $this->askPassword($input, $output, 'new-password', 'REGIBASE_NEW_PASSWORD', 'New master key');
				if (mb_strlen($new) < 6) {
					$output->writeln('<error>Master key must be at least 6 characters.</error>');
					return 1;
				}
				$newSalt = base64_encode(random_bytes(16));
				$newKey = $this->derive($new, $newSalt);
				$res = $this->sweep($uid, function (string $v) use ($oldKey, $newKey): array {
					if (!$this->isEnc($v)) {
						return [$this->enc($newKey, $v), true]; // encrypt any left-over plaintext too
					}
					$p = $this->dec($oldKey, $v);
					return $p === null ? [null, false] : [$this->enc($newKey, $p), true];
				});
				if ($res['fail'] > 0) {
					$output->writeln(sprintf('<error>%d value(s) failed to decrypt — master key NOT changed.</error>', $res['fail']));
					return 1;
				}
				$this->config->setUserValue($uid, $app, 'enc_salt', $newSalt);
				$this->config->setUserValue($uid, $app, 'enc_verifier', $this->enc($newKey, 'regibase-ok'));
				$output->writeln(sprintf('<info>Master key changed.</info> Re-encrypted %d value(s) in %d record(s).', $res['values'], $res['records']));
				return 0;

			case 'remove':
				if (!$enabled || $salt === '' || $verifier === '') {
					$output->writeln('<error>Encryption is not set up.</error>');
					return 1;
				}
				$cur = $this->askPassword($input, $output, 'password', 'REGIBASE_PASSWORD', 'Current master key');
				$oldKey = $this->derive($cur, $salt);
				if ($this->dec($oldKey, $verifier) !== 'regibase-ok') {
					$output->writeln('<error>Wrong current master key.</error>');
					return 1;
				}
				if (!$input->getOption('yes')) {
					$q = new Question('This decrypts every secret field to PLAIN TEXT and turns encryption off. Continue? [y/N] ', 'n');
					$ans = strtolower((string)$this->getHelper('question')->ask($input, $output, $q));
					if ($ans !== 'y' && $ans !== 'yes') {
						$output->writeln('Aborted.');
						return 0;
					}
				}
				$res = $this->sweep($uid, function (string $v) use ($oldKey): array {
					if (!$this->isEnc($v)) {
						return [null, true];
					}
					$p = $this->dec($oldKey, $v);
					return $p === null ? [null, false] : [$p, true];
				});
				if ($res['fail'] > 0) {
					$output->writeln(sprintf('<error>%d value(s) failed to decrypt — encryption NOT removed.</error>', $res['fail']));
					return 1;
				}
				$this->config->deleteUserValue($uid, $app, 'enc_enabled');
				$this->config->deleteUserValue($uid, $app, 'enc_salt');
				$this->config->deleteUserValue($uid, $app, 'enc_verifier');
				$output->writeln(sprintf('<info>Master key removed.</info> Decrypted %d value(s) in %d record(s); secret fields are now plain text.', $res['values'], $res['records']));
				return 0;

			default:
				$output->writeln('<error>Unknown action. Use: status | set | change | remove.</error>');
				return 1;
		}
	}

	/**
	 * Apply $transform to every non-empty secret-field value across the user's
	 * collections and persist changed records.
	 * $transform(string $v): array{0: ?string, 1: bool}  // [newValue|null, ok]
	 * @return array{records:int, values:int, fail:int}
	 */
	private function sweep(string $uid, callable $transform): array {
		$rc = 0;
		$vc = 0;
		$fail = 0;
		foreach ($this->collections->findAllForUser($uid) as $c) {
			$cid = (int)$c->getId();
			$keys = [];
			foreach ($this->fields->findForCollection($cid) as $f) {
				if ($f->getSecret()) {
					$keys[] = $f->getFieldKey();
				}
			}
			if (!$keys) {
				continue;
			}
			foreach ($this->records->findForCollection($cid) as $r) {
				$data = json_decode($r->getData() ?: '{}', true);
				if (!is_array($data)) {
					continue;
				}
				$dirty = false;
				foreach ($keys as $k) {
					$v = $data[$k] ?? null;
					if (!is_string($v) || $v === '') {
						continue;
					}
					[$nv, $ok] = $transform($v);
					if (!$ok) {
						$fail++;
						continue;
					}
					if ($nv !== null && $nv !== $v) {
						$data[$k] = $nv;
						$dirty = true;
						$vc++;
					}
				}
				if ($dirty) {
					$r->setData(json_encode($data, JSON_UNESCAPED_UNICODE));
					$this->records->update($r);
					$rc++;
				}
			}
		}
		return ['records' => $rc, 'values' => $vc, 'fail' => $fail];
	}

	private function askPassword(InputInterface $input, OutputInterface $output, string $opt, string $env, string $label): string {
		$v = $input->getOption($opt);
		if (is_string($v) && $v !== '') {
			return $v;
		}
		$e = getenv($env);
		if (is_string($e) && $e !== '') {
			return $e;
		}
		$q = new Question($label . ': ');
		$q->setHidden(true)->setHiddenFallback(false);
		$a = $this->getHelper('question')->ask($input, $output, $q);
		if (!is_string($a) || $a === '') {
			throw new \RuntimeException('No ' . $label . ' provided');
		}
		return $a;
	}

	private function derive(string $pw, string $saltB64): string {
		return hash_pbkdf2('sha256', $pw, base64_decode($saltB64), 250000, 32, true);
	}

	private function enc(string $key, string $plain): string {
		$iv = random_bytes(12);
		$tag = '';
		$ct = openssl_encrypt($plain, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, '', 16);
		return self::PREFIX . base64_encode($iv) . ':' . base64_encode($ct . $tag);
	}

	private function dec(string $key, string $val): ?string {
		if (strpos($val, self::PREFIX) !== 0) {
			return $val;
		}
		$parts = explode(':', substr($val, strlen(self::PREFIX)));
		if (count($parts) < 2) {
			return null;
		}
		$iv = base64_decode($parts[0], true);
		$blob = base64_decode($parts[1], true);
		if ($iv === false || $blob === false || strlen($blob) < 16) {
			return null;
		}
		$tag = substr($blob, -16);
		$c = substr($blob, 0, -16);
		$p = openssl_decrypt($c, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
		return $p === false ? null : $p;
	}

	private function isEnc(string $v): bool {
		return strpos($v, self::PREFIX) === 0;
	}
}
