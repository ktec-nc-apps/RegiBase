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
 * Per-field concatenation separator: the character placed before this field's
 * value when it is concatenated into another (concat_sep = none|space|fullspace|
 * custom; concat_sep_char holds the custom symbol).
 */
class Version000009Date20260730120000 extends SimpleMigrationStep {

	public function __construct(private IDBConnection $db) {
	}

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if ($schema->hasTable('regibase_fields')) {
			$t = $schema->getTable('regibase_fields');
			if (!$t->hasColumn('concat_sep')) {
				$t->addColumn('concat_sep', Types::STRING, ['notnull' => true, 'length' => 12, 'default' => 'space']);
			}
			if (!$t->hasColumn('concat_sep_char')) {
				// NOT NULL with empty-string default is rejected by DBAL → nullable.
				$t->addColumn('concat_sep_char', Types::STRING, ['notnull' => false, 'length' => 8, 'default' => '']);
			}
		}

		return $schema;
	}
}
