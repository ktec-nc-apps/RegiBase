<?php

declare(strict_types=1);

namespace OCA\RegiBase\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

class Version000003Date20260715000000 extends SimpleMigrationStep {

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('regibase_templates')) {
			$t = $schema->createTable('regibase_templates');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true]);
			$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			// stable per-user key; for a built-in override this equals builtin_key
			$t->addColumn('tpl_key', Types::STRING, ['notnull' => true, 'length' => 64]);
			// when set, this row overrides the built-in template with that key
			$t->addColumn('builtin_key', Types::STRING, ['notnull' => false, 'length' => 64]);
			$t->addColumn('name', Types::STRING, ['notnull' => true, 'length' => 255, 'default' => '']);
			$t->addColumn('icon', Types::STRING, ['notnull' => true, 'length' => 64, 'default' => '📁']);
			$t->addColumn('color', Types::STRING, ['notnull' => true, 'length' => 32, 'default' => '#3b82f6']);
			$t->addColumn('description', Types::TEXT, ['notnull' => false]);
			// field definitions as a JSON array
			$t->addColumn('fields', Types::TEXT, ['notnull' => false]);
			$t->addColumn('sort', Types::INTEGER, ['notnull' => true, 'default' => 0]);
			$t->addColumn('created_at', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->addColumn('updated_at', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['user_id'], 'regibase_tpl_user');
			$t->addUniqueIndex(['user_id', 'tpl_key'], 'regibase_tpl_uniq');
		}

		return $schema;
	}
}
