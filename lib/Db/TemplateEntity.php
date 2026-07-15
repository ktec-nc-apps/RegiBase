<?php

declare(strict_types=1);

namespace OCA\RegiBase\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method string getUserId()
 * @method void setUserId(string $v)
 * @method string getTplKey()
 * @method void setTplKey(string $v)
 * @method ?string getBuiltinKey()
 * @method void setBuiltinKey(?string $v)
 * @method string getName()
 * @method void setName(string $v)
 * @method string getIcon()
 * @method void setIcon(string $v)
 * @method string getColor()
 * @method void setColor(string $v)
 * @method ?string getDescription()
 * @method void setDescription(?string $v)
 * @method ?string getFields()
 * @method void setFields(?string $v)
 * @method int getSort()
 * @method void setSort(int $v)
 * @method string getCreatedAt()
 * @method void setCreatedAt(string $v)
 * @method string getUpdatedAt()
 * @method void setUpdatedAt(string $v)
 */
class TemplateEntity extends Entity implements \JsonSerializable {
	protected $userId = '';
	protected $tplKey = '';
	protected $builtinKey = null;
	protected $name = '';
	protected $icon = '📁';
	protected $color = '#3b82f6';
	protected $description = '';
	protected $fields = '[]';
	protected $sort = 0;
	protected $createdAt = '';
	protected $updatedAt = '';

	public function __construct() {
		$this->addType('sort', 'integer');
	}

	/** Decoded field definitions. @return array<int,array> */
	public function fieldsArray(): array {
		$d = json_decode($this->fields ?: '[]', true);
		return is_array($d) ? $d : [];
	}

	public function jsonSerialize(): array {
		return [
			'row_id' => (int)$this->id,
			'key' => $this->tplKey,
			'builtin_key' => $this->builtinKey,
			'name' => $this->name,
			'icon' => $this->icon,
			'color' => $this->color,
			'description' => $this->description ?? '',
			'fields' => $this->fieldsArray(),
		];
	}
}
