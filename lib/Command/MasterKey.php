<?php

declare(strict_types=1);

namespace OCA\RegiBase\Command;

use OCA\RegiBase\AppInfo\Application;
use OCA\RegiBase\Service\Kdf;
use OCA\RegiBase\Service\SecretSweep;
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
		$iter = Kdf::iterFor($this->config, $uid);

		switch ($action) {
			case 'status':
				$output->writeln('Encryption: ' . ($enabled ? '<info>enabled</info>' : '<comment>disabled</comment>'));
				$output->writeln('Salt set:    ' . ($salt !== '' ? 'yes' : 'no'));
				$output->writeln('Verifier:    ' . ($verifier !== '' ? 'yes' : 'no'));
				$output->writeln('KDF rounds:  ' . ($enabled ? number_format($iter) : '-'));
				return 0;

			case 'set':
				if ($enabled) {
					$output->writeln('<error>Encryption is already enabled. Use "change" to re-key, or "remove" first.</error>');
					return 1;
				}
				$new = $this->askPassword($input, $output, 'new-password', 'REGIBASE_NEW_PASSWORD', 'New master key');
				if (mb_strlen($new) < Kdf::MIN_KEY_LENGTH) {
					$output->writeln('<error>Master key must be at least ' . Kdf::MIN_KEY_LENGTH . ' characters.</error>');
					return 1;
				}
				$newSalt = base64_encode(random_bytes(16));
				$newKey = Kdf::derive($new, $newSalt, Kdf::CURRENT);
				$res = $this->sweep($uid, function (string $v) use ($newKey): array {
					return $this->isEnc($v) ? [null, true] : [$this->enc($newKey, $v), true];
				});
				$this->commit($res['pending'], function () use ($uid, $app, $newSalt, $newKey): void {
					$this->config->setUserValue($uid, $app, 'enc_salt', $newSalt);
					$this->config->setUserValue($uid, $app, 'enc_verifier', $this->enc($newKey, 'regibase-ok'));
					$this->config->setUserValue($uid, $app, 'enc_kdf_iter', (string)Kdf::CURRENT);
					$this->config->setUserValue($uid, $app, 'enc_enabled', '1');
				});
				$output->writeln(sprintf('<info>Encryption enabled.</info> Encrypted %d value(s) in %d record(s).', $res['values'], $res['records']));
				return 0;

			case 'change':
				if (!$enabled || $salt === '' || $verifier === '') {
					$output->writeln('<error>Encryption is not set up. Use "set".</error>');
					return 1;
				}
				$cur = $this->askPassword($input, $output, 'password', 'REGIBASE_PASSWORD', 'Current master key');
				$oldKey = Kdf::derive($cur, $salt, $iter);
				// a verifier that is not encrypted opens with any key (review K14)
				if (!$this->isEnc($verifier) || $this->dec($oldKey, $verifier) !== 'regibase-ok') {
					$output->writeln('<error>Wrong current master key.</error>');
					return 1;
				}
				$new = $this->askPassword($input, $output, 'new-password', 'REGIBASE_NEW_PASSWORD', 'New master key');
				if (mb_strlen($new) < Kdf::MIN_KEY_LENGTH) {
					$output->writeln('<error>Master key must be at least ' . Kdf::MIN_KEY_LENGTH . ' characters.</error>');
					return 1;
				}
				$newSalt = base64_encode(random_bytes(16));
				$newKey = Kdf::derive($new, $newSalt, Kdf::CURRENT);
				$res = $this->sweep($uid, function (string $v) use ($oldKey, $newKey): array {
					if (!$this->isEnc($v)) {
						return [$this->enc($newKey, $v), true]; // encrypt any left-over plaintext too
					}
					$p = $this->dec($oldKey, $v);
					return $p === null ? [null, false] : [$this->enc($newKey, $p), true];
				}, function (string $wrap) use ($oldKey, $newKey): array {
					// a collection with a key of its own: its values stay, its key is wrapped again
					$raw = $this->dec($oldKey, $wrap);
					return $raw === null ? [false, null, null] : [true, null, $this->enc($newKey, $raw), base64_decode($raw, true)];
				}, fn (string $v): ?string => $this->dec($oldKey, $v));
				if ($res['fail'] > 0) {
					// Nothing has been written: every value is still under the current key.
					$output->writeln(sprintf('<error>%d value(s) failed to decrypt — master key NOT changed, nothing was written.</error> Records: %s', $res['fail'], implode(', ', $res['failedIn'])));
					return 1;
				}
				$this->commit($res['pending'], function () use ($uid, $app, $newSalt, $newKey): void {
					$this->config->setUserValue($uid, $app, 'enc_salt', $newSalt);
					$this->config->setUserValue($uid, $app, 'enc_verifier', $this->enc($newKey, 'regibase-ok'));
					$this->config->setUserValue($uid, $app, 'enc_kdf_iter', (string)Kdf::CURRENT);
				});
				$output->writeln(sprintf('<info>Master key changed.</info> Re-encrypted %d value(s) in %d record(s).', $res['values'], $res['records']));
				return 0;

			case 'remove':
				if (!$enabled || $salt === '' || $verifier === '') {
					$output->writeln('<error>Encryption is not set up.</error>');
					return 1;
				}
				$cur = $this->askPassword($input, $output, 'password', 'REGIBASE_PASSWORD', 'Current master key');
				$oldKey = Kdf::derive($cur, $salt, $iter);
				// a verifier that is not encrypted opens with any key (review K14)
				if (!$this->isEnc($verifier) || $this->dec($oldKey, $verifier) !== 'regibase-ok') {
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
				}, function (string $wrap) use ($oldKey): array {
					$raw = $this->dec($oldKey, $wrap);
					$dek = $raw === null ? false : base64_decode($raw, true);
					if ($dek === false || strlen($dek) !== 32) {
						return [false, null, null];
					}
					$values = function (string $v) use ($dek): array {
						if (!$this->isEnc($v)) {
							return [null, true];
						}
						$p = $this->dec($dek, $v);
						return $p === null ? [null, false] : [$p, true];
					};
					return [true, $values, '', $dek];   // '' = the collection's key is taken away
				}, fn (string $v): ?string => $this->dec($oldKey, $v));
				if ($res['fail'] > 0) {
					$output->writeln(sprintf('<error>%d value(s) failed to decrypt — encryption NOT removed, nothing was written.</error> Records: %s', $res['fail'], implode(', ', $res['failedIn'])));
					return 1;
				}
				$this->commit($res['pending'], function () use ($uid, $app): void {
					$this->config->deleteUserValue($uid, $app, 'enc_enabled');
					$this->config->deleteUserValue($uid, $app, 'enc_salt');
					$this->config->deleteUserValue($uid, $app, 'enc_verifier');
					$this->config->deleteUserValue($uid, $app, 'enc_kdf_iter');
				});
				$output->writeln(sprintf('<info>Master key removed.</info> Decrypted %d value(s) in %d record(s); secret fields are now plain text.', $res['values'], $res['records']));
				return 0;

			default:
				$output->writeln('<error>Unknown action. Use: status | set | change | remove.</error>');
				return 1;
		}
	}

	/**
	 * Work out $transform for every non-empty secret-field value across the user's
	 * collections -- hidden ones included -- WITHOUT writing anything.
	 *
	 * It used to write each record the moment it was done. One value that would not
	 * decrypt then left the records already written under a new key whose salt was
	 * thrown away: "NOT changed" was printed, and those secrets could never be read
	 * again (review P1/K4). Now nothing is written until every value has come
	 * through, and then all of it goes in one transaction (commit()).
	 * $transform(string $v): array{0: ?string, 1: bool}  // [newValue|null, ok]
	 * @return array{records:int, values:int, fail:int, failedIn:list<string>, pending:list<array{0:mixed,1:string}>}
	 */
	/**
	 * @param callable|null $fromMaster opens a value under the current master key (null if it
	 *        does not open). A collection with a key of its own can still have values under the
	 *        master key in its versions and undo history, from before it got its key; they are
	 *        opened with it and put under the collection key, or to plain text when the key goes
	 *        (review, second look).
	 */
	private function sweep(string $uid, callable $transform, ?callable $forWrapped = null, ?callable $fromMaster = null): array {
		$rc = 0;
		$vc = 0;
		$fail = 0;
		$failedIn = [];
		$pending = [];
		$wraps = [];
		$tfFor = [];   // collection id -> the transform for its values (absent = leave them)
		$dekFor = [];  // collection id -> [its own key (raw), the transform for its values or null]
		foreach ($this->collections->findAllForUser($uid) as $c) {
			$cid = (int)$c->getId();
			// A collection shared with its secrets has a key of its own (wrapped with the
			// master key). $forWrapped says what happens to it: [ok, value transform or
			// null to leave the values, new wrap or '' to take the key away].
			$doValues = $transform;
			$wrap = (string)($c->getKeyWrap() ?? '');
			if ($wrap !== '') {
				if ($forWrapped === null) {
					continue;
				}
				[$okW, $vt, $newWrap, $dek] = $forWrapped($wrap) + [false, null, null, null];
				if (!$okW) {
					$fail++;
					$failedIn[] = 'collection #' . $cid . ' (its key)';
					continue;
				}
				$wraps[] = [$c, $newWrap];
				if (is_string($dek) && strlen($dek) === 32) {
					$dekFor[$cid] = [$dek, $vt];
				}
				if ($vt === null) {
					continue;
				}
				$doValues = $vt;
			}
			$tfFor[$cid] = $doValues;
			$keys = [];
			foreach ($this->fields->findForCollection($cid) as $f) {
				if ($f->getSecret()) {
					$keys[] = $f->getFieldKey();
				}
			}
			foreach ($this->records->findForCollection($cid) as $r) {
				$data = json_decode($r->getData() ?: '{}', true);
				if (!is_array($data)) {
					continue;
				}
				$dirty = false;
				// secret fields, and ciphertext left in a field that is no longer secret (review P9)
				foreach (SecretSweep::pick($data, $keys) as $k => $v) {
					[$nv, $ok] = $doValues($v);
					if (!$ok) {
						$fail++;
						$failedIn[] = '#' . $r->getId() . ' (' . $k . ')';
						continue;
					}
					if ($nv !== null && $nv !== $v) {
						$data[$k] = $nv;
						$dirty = true;
						$vc++;
					}
				}
				if ($dirty) {
					$pending[] = [$r, json_encode($data, JSON_UNESCAPED_UNICODE)];
					$rc++;
				}
			}
		}
		// The same values in the versions and the undo history (review P9, K12).
		$sweep = \OCP\Server::get(SecretSweep::class);
		$extra = $sweep->collect($uid);
		$histWraps = [];
		foreach ($extra['wraps'] as $ref => $wrap) {
			if ($forWrapped === null) {
				continue;
			}
			[$okW, $vt, $newWrap, $dek] = $forWrapped($wrap) + [false, null, null, null];
			if (!$okW) {
				continue; // a deleted collection's key that no longer opens: its values stay as they are
			}
			$histWraps[$ref] = $newWrap;
			if (is_string($dek) && strlen($dek) === 32) {
				$dekFor[$ref] = [$dek, $vt];
			}
			if ($vt !== null) {
				$tfFor[$ref] = $vt;
			}
		}
		$out = ['vers' => [], 'hist' => []];
		foreach (['vers', 'hist'] as $kind) {
			foreach ($extra[$kind] as $it) {
				$tf = $tfFor[$it['collection']] ?? (is_int($it['collection']) || isset($extra['wraps'][$it['collection']]) ? null : $transform);
				if (isset($dekFor[$it['collection']])) {
					[$dek, $vt] = $dekFor[$it['collection']];
					$tf = function (string $v) use ($dek, $vt, $fromMaster): array {
						if (!$this->isEnc($v) || $this->dec($dek, $v) !== null) {
							return $vt !== null ? $vt($v) : [null, true];
						}
						$p = $fromMaster !== null ? $fromMaster($v) : null;
						if ($p === null) {
							return [null, false];
						}
						return $vt !== null ? [$p, true] : [$this->enc($dek, $p), true];
					};
				}
				if ($tf === null) {
					continue;
				}
				$data = [];
				foreach ($it['data'] as $k => $v) {
					[$nv, $ok] = $tf($v);
					if (!$ok) {
						// already unreadable (left from before this sweep existed): it stays as it is
						continue;
					}
					if ($nv !== null && $nv !== $v) {
						$data[$k] = $nv;
						$vc++;
					}
				}
				if ($data) {
					$out[$kind][] = ['ref' => $it['ref'], 'data' => $data];
				}
			}
		}
		$plan = $fail ? [] : $sweep->plan($uid, $out['vers'], $out['hist'], $histWraps);
		return ['records' => $rc, 'values' => $vc, 'fail' => $fail, 'failedIn' => $failedIn, 'pending' => ['records' => $pending, 'wraps' => $wraps, 'extra' => $plan]];
	}

	/** Write every record and the key settings together, or none of them. */
	private function commit(array $pending, callable $settings): void {
		$db = \OCP\Server::get(\OCP\IDBConnection::class);
		$db->beginTransaction();
		try {
			foreach ($pending['records'] as [$r, $json]) {
				$r->setData($json);
				$this->records->update($r);
			}
			\OCP\Server::get(SecretSweep::class)->write($pending['extra'] ?? []);
			foreach ($pending['wraps'] as [$c, $newWrap]) {
				$c->setKeyWrap($newWrap === '' ? null : $newWrap);
				$this->collections->update($c);
				if ($newWrap === '') {
					// no key of its own any more: the shares' wrapped copies of it go too
					$sm = \OCP\Server::get(\OCA\RegiBase\Db\ShareMapper::class);
					foreach ($sm->findForCollection((int)$c->getId()) as $sh) {
						$sh->setEncKey(null);
						$sh->setEncSalt(null);
						$sm->update($sh);
					}
				}
			}
			$settings();
			$db->commit();
		} catch (\Throwable $e) {
			$db->rollBack();
			throw $e;
		}
	}

	private function askPassword(InputInterface $input, OutputInterface $output, string $opt, string $env, string $label): string {
		$v = $input->getOption($opt);
		if (is_string($v) && $v !== '') {
			$this->warnPasswordOption($output, $opt);
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
