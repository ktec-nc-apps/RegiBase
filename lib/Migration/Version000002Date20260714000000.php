<?php

declare(strict_types=1);

namespace OCA\RegiBase\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

class Version000002Date20260714000000 extends SimpleMigrationStep {

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('regibase_shares')) {
			$t = $schema->createTable('regibase_shares');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true]);
			$t->addColumn('collection_id', Types::BIGINT, ['notnull' => true]);
			$t->addColumn('owner_uid', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('recipient_uid', Types::STRING, ['notnull' => true, 'length' => 64]);
			// permission level: 'view' | 'edit' | 'delete'
			$t->addColumn('perm', Types::STRING, ['notnull' => true, 'length' => 8, 'default' => 'view']);
			// optional share access password (password_hash of the plain share password)
			$t->addColumn('pw_hash', Types::STRING, ['notnull' => false, 'length' => 255]);
			// optional: the owner's encryption key, wrapped with the share password,
			// so a recipient can decrypt this collection's secret fields. Null = secrets hidden.
			$t->addColumn('enc_key', Types::TEXT, ['notnull' => false]);
			$t->addColumn('enc_salt', Types::STRING, ['notnull' => false, 'length' => 128]);
			$t->addColumn('created_at', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['collection_id'], 'regibase_share_coll');
			$t->addIndex(['recipient_uid'], 'regibase_share_rcpt');
			$t->addUniqueIndex(['collection_id', 'recipient_uid'], 'regibase_share_uniq');
		}

		return $schema;
	}
}
