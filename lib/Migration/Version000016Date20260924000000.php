<?php

declare(strict_types=1);

namespace OCA\RegiBase\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Sharing with a key of its own (owner, 2026-09-24): the owner's master key is
 * never handed to anybody. A collection that is shared with its secrets gets a
 * random key of its own; the owner keeps it wrapped with their master key
 * (collections.key_wrap), each share keeps it wrapped with that share's password
 * (shares.enc_key). The share password itself never reaches the server: it is
 * checked with a value derived from it (shares.auth_salt). A share can end on a
 * date (shares.expires_at); past it, its wrapped key is erased.
 */
class Version000016Date20260924000000 extends SimpleMigrationStep {
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		$c = $schema->getTable('regibase_collections');
		if (!$c->hasColumn('key_wrap')) {
			$c->addColumn('key_wrap', Types::TEXT, ['notnull' => false]);
		}
		$s = $schema->getTable('regibase_shares');
		if (!$s->hasColumn('expires_at')) {
			$s->addColumn('expires_at', Types::STRING, ['notnull' => false, 'length' => 32]);
		}
		if (!$s->hasColumn('auth_salt')) {
			$s->addColumn('auth_salt', Types::STRING, ['notnull' => false, 'length' => 64]);
		}
		return $schema;
	}
}
