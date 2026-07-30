<?php

declare(strict_types=1);

namespace OCA\RegiBase\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Per-field "show in list" flag. Controls whether a field appears in the
 * list / card views' summary line. Defaults to true so existing fields keep
 * showing; the user turns off the ones they do not want.
 */
class Version000012Date20260730180000 extends SimpleMigrationStep {

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if (!$schema->hasTable('regibase_fields')) {
			return $schema;
		}
		$t = $schema->getTable('regibase_fields');
		if (!$t->hasColumn('list_show')) {
			$t->addColumn('list_show', Types::BOOLEAN, ['notnull' => false, 'default' => true]);
		}
		return $schema;
	}
}
