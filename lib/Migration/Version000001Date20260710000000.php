<?php

declare(strict_types=1);

namespace OCA\RegiBase\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

class Version000001Date20260710000000 extends SimpleMigrationStep {

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('regibase_collections')) {
			$t = $schema->createTable('regibase_collections');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true]);
			$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('name', Types::STRING, ['notnull' => true, 'length' => 255]);
			$t->addColumn('icon', Types::STRING, ['notnull' => true, 'length' => 16, 'default' => '📁']);
			$t->addColumn('color', Types::STRING, ['notnull' => true, 'length' => 16, 'default' => '#3b82f6']);
			$t->addColumn('description', Types::TEXT, ['notnull' => false]);
			$t->addColumn('view', Types::STRING, ['notnull' => true, 'length' => 16, 'default' => 'list']);
			$t->addColumn('record_sort', Types::STRING, ['notnull' => true, 'length' => 24, 'default' => 'created_desc']);
			$t->addColumn('sort', Types::INTEGER, ['notnull' => true, 'default' => 0]);
			$t->addColumn('created_at', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->addColumn('updated_at', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['user_id'], 'regibase_coll_user');
		}

		if (!$schema->hasTable('regibase_fields')) {
			$t = $schema->createTable('regibase_fields');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true]);
			$t->addColumn('collection_id', Types::BIGINT, ['notnull' => true]);
			$t->addColumn('field_key', Types::STRING, ['notnull' => true, 'length' => 191]);
			$t->addColumn('label', Types::STRING, ['notnull' => true, 'length' => 255]);
			$t->addColumn('type', Types::STRING, ['notnull' => true, 'length' => 24, 'default' => 'text']);
			$t->addColumn('options', Types::TEXT, ['notnull' => false]);
			$t->addColumn('required', Types::BOOLEAN, ['notnull' => false, 'default' => false]);
			$t->addColumn('secret', Types::BOOLEAN, ['notnull' => false, 'default' => false]);
			$t->addColumn('is_title', Types::BOOLEAN, ['notnull' => false, 'default' => false]);
			$t->addColumn('placeholder', Types::STRING, ['notnull' => false, 'length' => 255]);
			$t->addColumn('sort', Types::INTEGER, ['notnull' => true, 'default' => 0]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['collection_id'], 'regibase_field_coll');
		}

		if (!$schema->hasTable('regibase_records')) {
			$t = $schema->createTable('regibase_records');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true]);
			$t->addColumn('collection_id', Types::BIGINT, ['notnull' => true]);
			$t->addColumn('data', Types::TEXT, ['notnull' => true, 'default' => '{}']);
			$t->addColumn('reading', Types::TEXT, ['notnull' => false]);
			$t->addColumn('created_at', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->addColumn('updated_at', Types::STRING, ['notnull' => true, 'length' => 32]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['collection_id'], 'regibase_rec_coll');
		}

		return $schema;
	}
}
