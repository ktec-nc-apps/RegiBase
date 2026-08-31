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
 * Per-record version history, kept the way EditBase keeps numbered version
 * files beside a document: #1 is always the most recent snapshot of a
 * record's own fields, older ones shift down, and the oldest falls off once
 * past the user's keep-count.
 */
class Version000015Date20260901000000 extends SimpleMigrationStep {

	public function __construct(private IDBConnection $db) {
	}

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('regibase_rec_vers')) {
			$t = $schema->createTable('regibase_rec_vers');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'length' => 20]);
			$t->addColumn('record_id', Types::BIGINT, ['notnull' => true, 'length' => 20]);
			$t->addColumn('number', Types::INTEGER, ['notnull' => true, 'length' => 4]);
			// JSON snapshot of the record's own fields at that point: {data, reading}.
			$t->addColumn('data', Types::TEXT, ['notnull' => true, 'default' => '{}']);
			$t->addColumn('created_at', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->setPrimaryKey(['id']);
			$t->addUniqueIndex(['record_id', 'number'], 'regibase_ver_rec_num');
		}

		return $schema;
	}
}
