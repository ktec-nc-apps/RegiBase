<?php

declare(strict_types=1);

namespace OCA\RegiBase\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Undo / change-history journal. Every data-mutating operation appends one row
 * holding a compact "inverse" payload; the newest non-undone row (or group of
 * rows) can be reverted. Retention is bounded per user by a configurable limit.
 */
class Version000007Date20260729120000 extends SimpleMigrationStep {

	public function __construct(private IDBConnection $db) {
	}

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('regibase_history')) {
			$t = $schema->createTable('regibase_history');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'length' => 20]);
			$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('op', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->addColumn('collection_id', Types::BIGINT, ['notnull' => false, 'length' => 20]);
			$t->addColumn('summary', Types::STRING, ['notnull' => true, 'length' => 255, 'default' => '']);
			// groups the individual API calls of one logical action (e.g. a schema
			// save that touches several records) so they undo together.
			$t->addColumn('grp', Types::STRING, ['notnull' => false, 'length' => 40]);
			// JSON inverse payload; may be gzip+base64 for large snapshots.
			$t->addColumn('undo_data', Types::TEXT, ['notnull' => false]);
			// DBAL rejects NOT NULL boolean w/ default false → keep nullable (null = false).
			$t->addColumn('undone', Types::BOOLEAN, ['notnull' => false, 'default' => false]);
			$t->addColumn('created_at', Types::STRING, ['notnull' => true, 'length' => 32, 'default' => '']);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['user_id', 'id'], 'regibase_hist_user');
		}

		return $schema;
	}
}
