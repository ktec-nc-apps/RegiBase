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
 * Add a per-field `concat` group id. Fields sharing the same non-zero group are
 * shown combined (values joined in field order) as one column/value — e.g. a
 * last-name + first-name pair. Independent of the title/emphasis flag.
 */
class Version000008Date20260730000000 extends SimpleMigrationStep {

	public function __construct(private IDBConnection $db) {
	}

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if ($schema->hasTable('regibase_fields')) {
			$t = $schema->getTable('regibase_fields');
			if (!$t->hasColumn('concat')) {
				$t->addColumn('concat', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			}
		}

		return $schema;
	}
}
