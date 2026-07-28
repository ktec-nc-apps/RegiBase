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
 * Add a per-collection `locked` flag (edit lock). When set, the collection is
 * view-only: records and fields cannot be added, edited or deleted. Existing
 * collections default to unlocked.
 */
class Version000005Date20260728000000 extends SimpleMigrationStep {

	public function __construct(private IDBConnection $db) {
	}

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if ($schema->hasTable('regibase_collections')) {
			$t = $schema->getTable('regibase_collections');
			if (!$t->hasColumn('locked')) {
				// A NOT NULL boolean with default false is rejected by DBAL, so keep
				// it nullable; the entity/JSON layer treats null as false.
				$t->addColumn('locked', Types::BOOLEAN, ['notnull' => false, 'default' => false]);
			}
		}

		return $schema;
	}
}
