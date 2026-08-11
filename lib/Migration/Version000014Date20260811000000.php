<?php

declare(strict_types=1);

namespace OCA\RegiBase\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Secret collections. `secret` hides the collection from the list until the
 * session is unlocked with its 6-digit key; `secret_hash` stores the bcrypt hash
 * of that key (nullable — most collections have none).
 */
class Version000014Date20260811000000 extends SimpleMigrationStep {

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if (!$schema->hasTable('regibase_collections')) {
			return $schema;
		}
		$t = $schema->getTable('regibase_collections');
		if (!$t->hasColumn('secret')) {
			$t->addColumn('secret', Types::BOOLEAN, ['notnull' => false, 'default' => false]);
		}
		if (!$t->hasColumn('secret_hash')) {
			// nullable string: a NOT NULL string column cannot take an empty-string
			// default on all DBs, so keep it nullable (no key set = NULL).
			$t->addColumn('secret_hash', Types::STRING, ['notnull' => false, 'length' => 255, 'default' => null]);
		}
		return $schema;
	}
}
