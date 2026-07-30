<?php

declare(strict_types=1);

namespace OCA\RegiBase\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Split the single "show in list" flag into per-view flags. `list_show` (added
 * earlier) keeps controlling the list view; add `table_show` and `card_show`.
 * All default to true so nothing is hidden until the user turns it off.
 */
class Version000013Date20260730190000 extends SimpleMigrationStep {

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if (!$schema->hasTable('regibase_fields')) {
			return $schema;
		}
		$t = $schema->getTable('regibase_fields');
		if (!$t->hasColumn('table_show')) {
			$t->addColumn('table_show', Types::BOOLEAN, ['notnull' => false, 'default' => true]);
		}
		if (!$t->hasColumn('card_show')) {
			$t->addColumn('card_show', Types::BOOLEAN, ['notnull' => false, 'default' => true]);
		}
		return $schema;
	}
}
