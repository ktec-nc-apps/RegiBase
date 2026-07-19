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
 * Add a per-record `sort` position column so the registration order of records
 * can be changed (manual drag reorder, or a one-shot sort by a chosen field).
 * Existing records are back-filled with sort = id, preserving the current order.
 */
class Version000004Date20260719000000 extends SimpleMigrationStep {

	public function __construct(private IDBConnection $db) {
	}

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if ($schema->hasTable('regibase_records')) {
			$t = $schema->getTable('regibase_records');
			if (!$t->hasColumn('sort')) {
				$t->addColumn('sort', Types::INTEGER, ['notnull' => true, 'default' => 0]);
			}
		}

		return $schema;
	}

	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		// Seed the new column so existing records keep their current (id) order.
		// Idempotent: only touches rows still at the default 0.
		$qb = $this->db->getQueryBuilder();
		$qb->update('regibase_records')
			->set('sort', 'id')
			->where($qb->expr()->eq('sort', $qb->createNamedParameter(0)));
		$qb->executeStatement();
	}
}
