<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method string getUserId()
 * @method void setUserId(string $v)
 * @method string getName()
 * @method void setName(string $v)
 * @method string getIcon()
 * @method void setIcon(string $v)
 * @method string getColor()
 * @method void setColor(string $v)
 * @method ?string getDescription()
 * @method void setDescription(?string $v)
 * @method string getView()
 * @method void setView(string $v)
 * @method string getRecordSort()
 * @method void setRecordSort(string $v)
 * @method int getSort()
 * @method void setSort(int $v)
 * @method string getCreatedAt()
 * @method void setCreatedAt(string $v)
 * @method string getUpdatedAt()
 * @method void setUpdatedAt(string $v)
 */
class CollectionEntity extends Entity implements \JsonSerializable {
	protected $userId = '';
	protected $name = '';
	protected $icon = '📁';
	protected $color = '#3b82f6';
	protected $description = '';
	protected $view = 'list';
	protected $recordSort = 'created_desc';
	protected $sort = 0;
	protected $createdAt = '';
	protected $updatedAt = '';

	public function __construct() {
		$this->addType('sort', 'integer');
	}

	public function jsonSerialize(): array {
		return [
			'id' => (int)$this->id,
			'name' => $this->name,
			'icon' => $this->icon,
			'color' => $this->color,
			'description' => $this->description ?? '',
			'view' => $this->view,
			'record_sort' => $this->recordSort,
			'created_at' => $this->createdAt,
			'updated_at' => $this->updatedAt,
		];
	}
}
