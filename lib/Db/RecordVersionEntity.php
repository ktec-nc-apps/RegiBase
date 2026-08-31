<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method int getRecordId()
 * @method void setRecordId(int $v)
 * @method int getNumber()
 * @method void setNumber(int $v)
 * @method string getData()
 * @method void setData(string $v)
 * @method string getCreatedAt()
 * @method void setCreatedAt(string $v)
 */
class RecordVersionEntity extends Entity implements \JsonSerializable {
	protected $recordId = 0;
	protected $number = 0;
	protected $data = '{}';
	protected $createdAt = '';

	public function __construct() {
		$this->addType('recordId', 'integer');
		$this->addType('number', 'integer');
	}

	/** The listing shape: no field contents, just enough to pick a version to open. */
	public function jsonSerialize(): array {
		return [
			'number' => (int)$this->number,
			'size' => strlen($this->data ?? ''),
			'created_at' => $this->createdAt,
		];
	}
}
