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
 * Per-collection key (title) display options:
 *  - key_head:     show the key field(s) combined into one leading column in the
 *                  table view (default off; individual key columns are shown).
 *  - key_sep:      how key field values are joined to form the record title —
 *                  'none' | 'space' | 'fullspace' | 'custom'. Default 'space'
 *                  keeps the previous half-width-space behaviour.
 *  - key_sep_char: the symbol used when key_sep = 'custom'.
 */
class Version000006Date20260729000000 extends SimpleMigrationStep {

	public function __construct(private IDBConnection $db) {
	}

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if ($schema->hasTable('regibase_collections')) {
			$t = $schema->getTable('regibase_collections');
			if (!$t->hasColumn('key_head')) {
				// A NOT NULL boolean with default false is rejected by DBAL, so keep
				// it nullable; the entity/JSON layer treats null as false.
				$t->addColumn('key_head', Types::BOOLEAN, ['notnull' => false, 'default' => false]);
			}
			if (!$t->hasColumn('key_sep')) {
				$t->addColumn('key_sep', Types::STRING, ['notnull' => true, 'length' => 12, 'default' => 'space']);
			}
			if (!$t->hasColumn('key_sep_char')) {
				// A NOT NULL column with an empty-string default is rejected by DBAL,
				// so keep it nullable; the entity/JSON layer treats null as ''.
				$t->addColumn('key_sep_char', Types::STRING, ['notnull' => false, 'length' => 8, 'default' => '']);
			}
		}

		return $schema;
	}
}
