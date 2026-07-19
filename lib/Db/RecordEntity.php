<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method int getCollectionId()
 * @method void setCollectionId(int $v)
 * @method string getData()
 * @method void setData(string $v)
 * @method ?string getReading()
 * @method void setReading(?string $v)
 * @method int getSort()
 * @method void setSort(int $v)
 * @method string getCreatedAt()
 * @method void setCreatedAt(string $v)
 * @method string getUpdatedAt()
 * @method void setUpdatedAt(string $v)
 */
class RecordEntity extends Entity implements \JsonSerializable {
	protected $collectionId = 0;
	protected $data = '{}';
	protected $reading = '';
	protected $sort = 0;
	protected $createdAt = '';
	protected $updatedAt = '';

	public function __construct() {
		$this->addType('collectionId', 'integer');
		$this->addType('sort', 'integer');
	}

	public function jsonSerialize(): array {
		return [
			'id' => (int)$this->id,
			'collection_id' => (int)$this->collectionId,
			'data' => json_decode($this->data ?: '{}', true),
			'reading' => $this->reading ?? '',
			'sort' => (int)$this->sort,
			'created_at' => $this->createdAt,
			'updated_at' => $this->updatedAt,
		];
	}
}
