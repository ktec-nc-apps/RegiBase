<?php

declare(strict_types=1);

namespace OCA\RegiBase\Command;

use OCA\RegiBase\AppInfo\Application;
use OCA\RegiBase\Db\CollectionEntity;
use OCA\RegiBase\Db\CollectionMapper;
use OCA\RegiBase\Db\FieldMapper;
use OCA\RegiBase\Db\RecordMapper;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\IConfig;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Question\Question;

/**
 * Shared helpers for the RegiBase occ commands: collection resolution and the
 * server-side mirror of the app's client-side secret encryption.
 *
 * Encryption (must stay in sync with js/regibase.js rbcrypto):
 *   key   = PBKDF2-SHA256(password, base64_decode(enc_salt), enc_kdf_iter (250000 when unset), 32 bytes)
 *   value = "rbenc1:" + base64(iv[12]) + ":" + base64(ciphertext || tag[16])   [AES-256-GCM]
 * enc_salt / enc_verifier live in the user's preferences; the plaintext key is
 * never stored, so a password is required to reveal secret fields.
 */
abstract class Base extends Command {
	/** Whether --reveal was given: without it a secret field is masked even when stored as plain text. */
	private bool $revealing = false;

	protected const ENC_PREFIX = 'rbenc1:';

	public function __construct(
		protected CollectionMapper $collections,
		protected FieldMapper $fields,
		protected RecordMapper $records,
		protected IConfig $config,
	) {
		parent::__construct();
	}

	/** Add the --user option shared by every command. */
	protected function addUserOption(): static {
		$this->addOption('user', 'u', InputOption::VALUE_REQUIRED,
			'Limit to / disambiguate by this user id');
		return $this;
	}

	/** Add the secret-reveal options shared by the reading commands. */
	protected function addRevealOptions(): static {
		$this->addOption('reveal', null, InputOption::VALUE_NONE,
			'Decrypt secret fields (needs the master password)');
		$this->addOption('password', null, InputOption::VALUE_REQUIRED,
			'Master password (discouraged; prefer REGIBASE_PASSWORD env or the interactive prompt)');
		return $this;
	}

	/**
	 * Resolve the "collection" argument, which may be a numeric id or a name.
	 * Honours --user when given.
	 */
	protected function resolveCollection(InputInterface $input): CollectionEntity {
		$ref = (string)$input->getArgument('collection');
		$user = $input->getOption('user');
		$user = is_string($user) && $user !== '' ? $user : null;

		if (ctype_digit($ref)) {
			try {
				$c = $this->collections->findById((int)$ref);
			} catch (DoesNotExistException $e) {
				throw new \RuntimeException("Collection #$ref not found");
			}
			if ($user !== null && $c->getUserId() !== $user) {
				throw new \RuntimeException("Collection #$ref does not belong to user '$user'");
			}
			return $c;
		}

		$pool = $user !== null ? $this->collections->findAllForUser($user) : $this->collections->findAll();
		$matches = array_values(array_filter($pool, fn (CollectionEntity $c) => $c->getName() === $ref));
		if (count($matches) === 0) {
			throw new \RuntimeException("No collection named '$ref'" . ($user ? " for user '$user'" : ''));
		}
		if (count($matches) > 1) {
			$ids = implode(', ', array_map(fn ($c) => '#' . $c->getId() . ' (' . $c->getUserId() . ')', $matches));
			throw new \RuntimeException("Several collections named '$ref': $ids — pass an id or --user");
		}
		return $matches[0];
	}

	/**
	 * Derive and verify the AES key for a user's secret fields, or return null
	 * when the caller did not ask to reveal secrets. Throws on a wrong password
	 * or when encryption is not set up.
	 */
	protected function secretKey(string $uid, InputInterface $input, OutputInterface $output): ?string {
		$this->revealing = (bool)$input->getOption('reveal');
		if (!$this->revealing) {
			return null;
		}
		$enabled = $this->config->getUserValue($uid, Application::APP_ID, 'enc_enabled', '0') === '1';
		$salt = $this->config->getUserValue($uid, Application::APP_ID, 'enc_salt', '');
		$verifier = $this->config->getUserValue($uid, Application::APP_ID, 'enc_verifier', '');
		if (!$enabled || $salt === '' || $verifier === '') {
			// no master key: secret fields are stored as they are, and --reveal shows them
			return null;
		}

		$password = $this->resolvePassword($input, $output);
		$key = \OCA\RegiBase\Service\Kdf::derive($password, $salt, \OCA\RegiBase\Service\Kdf::iterFor($this->config, $uid));
		// a verifier that is not encrypted opens with any key (review K14)
		if (strpos($verifier, self::ENC_PREFIX) !== 0 || $this->decryptWith($key, $verifier) !== 'regibase-ok') {
			throw new \RuntimeException('Wrong master password');
		}
		return $key;
	}

	/**
	 * The key a collection's secrets are under: its own key when it has been shared
	 * with its secrets (kept wrapped with the master key), otherwise the master key.
	 */
	protected function collectionKey(?string $masterKey, $collection): ?string {
		// (Entity getters are magic: method_exists() says no, so it is called directly.)
		$wrap = (string)($collection->getKeyWrap() ?? '');
		if ($masterKey === null || $wrap === '') {
			return $masterKey;
		}
		$raw = $this->decryptWith($masterKey, $wrap);
		$key = $raw === null ? false : base64_decode($raw, true);
		if ($key === false || strlen($key) !== 32) {
			throw new \RuntimeException('The collection key could not be opened with this master password');
		}
		return $key;
	}

	/** --password → REGIBASE_PASSWORD env → interactive hidden prompt. */
	private function resolvePassword(InputInterface $input, OutputInterface $output): string {
		$opt = $input->getOption('password');
		if (is_string($opt) && $opt !== '') {
			$this->warnPasswordOption($output, 'password');
			return $opt;
		}
		$env = getenv('REGIBASE_PASSWORD');
		if (is_string($env) && $env !== '') {
			return $env;
		}
		$helper = $this->getHelper('question');
		$q = new Question('Master password: ');
		$q->setHidden(true)->setHiddenFallback(false);
		$answer = $helper->ask($input, $output, $q);
		if (!is_string($answer) || $answer === '') {
			throw new \RuntimeException('No password provided');
		}
		return $answer;
	}

	/**
	 * Decrypt a stored value. Plaintext (no rbenc1 prefix) passes through.
	 * Returns null on a decryption failure. $key null means "don't decrypt":
	 * secret ciphertext is returned masked. A secret field ($secret) is masked without
	 * --reveal even when it is stored as plain text (a user without a master key): it
	 * used to be printed as it was, and output is often collected in logs (review P19).
	 */
	protected function reveal(?string $key, $value, bool $secret = false): ?string {
		if ($value === null) {
			return null;
		}
		$value = (string)$value;
		if ($secret && !$this->revealing && $value !== '') {
			return '••••••• (secret; use --reveal)';
		}
		if (strpos($value, self::ENC_PREFIX) !== 0) {
			return $value;
		}
		if ($key === null) {
			return '••••••• (encrypted; use --reveal)';
		}
		$plain = $this->decryptWith($key, $value);
		return $plain ?? '‹decryption failed›';
	}

	/** A password given on the command line is seen in the process list and the shell history (review P19). */
	protected function warnPasswordOption(OutputInterface $output, string $opt): void {
		$err = $output instanceof \Symfony\Component\Console\Output\ConsoleOutputInterface ? $output->getErrorOutput() : $output;
		$err->writeln('<comment>Warning: --' . $opt . ' can be seen in the process list and the shell history. Prefer the environment variable or the prompt.</comment>');
	}

	/** Raw AES-256-GCM decrypt of a rbenc1 value. Returns null on failure. */
	private function decryptWith(string $key, string $value): ?string {
		if (strpos($value, self::ENC_PREFIX) !== 0) {
			return $value;
		}
		$parts = explode(':', substr($value, strlen(self::ENC_PREFIX)));
		if (count($parts) < 2) {
			return null;
		}
		$iv = base64_decode($parts[0], true);
		$blob = base64_decode($parts[1], true);
		if ($iv === false || $blob === false || strlen($blob) < 16) {
			return null;
		}
		$tag = substr($blob, -16);
		$ct = substr($blob, 0, -16);
		$plain = openssl_decrypt($ct, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
		return $plain === false ? null : $plain;
	}

	/** The record's title, taken from the is_title field (decrypted if possible). */
	protected function titleOf(array $fieldsByKey, array $data, ?string $key): string {
		foreach ($fieldsByKey as $fk => $f) {
			if ($f->getIsTitle()) {
				$v = $this->reveal($key, $data[$fk] ?? '', (bool)$f->getSecret());
				return $v !== null && $v !== '' ? $v : '(untitled)';
			}
		}
		// Fall back to the first field.
		$first = array_key_first($fieldsByKey);
		if ($first !== null) {
			$v = $this->reveal($key, $data[$first] ?? '', (bool)$fieldsByKey[$first]->getSecret());
			if ($v !== null && $v !== '') {
				return $v;
			}
		}
		return '(untitled)';
	}
}
