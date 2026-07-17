<?php

declare(strict_types=1);

namespace OCA\RegiBase\Command;

use OCP\AppFramework\Db\DoesNotExistException;
use Symfony\Component\Console\Helper\Table;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

class GetRecord extends Base {
	protected function configure(): void {
		$this->setName('regibase:get')
			->setDescription('Show a single record')
			->addArgument('collection', InputArgument::REQUIRED, 'Collection id or name')
			->addArgument('record', InputArgument::REQUIRED, 'Record id')
			->addUserOption()
			->addRevealOptions()
			->addOption('field', 'f', InputOption::VALUE_REQUIRED,
				'Print only this field (key like "c8" or its label), raw — handy for scripts')
			->addOption('output', 'o', InputOption::VALUE_REQUIRED, 'Output format: table (default) or json', 'table');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$c = $this->resolveCollection($input);
		$rid = (string)$input->getArgument('record');
		if (!ctype_digit($rid)) {
			throw new \RuntimeException('Record id must be numeric');
		}
		try {
			$rec = $this->records->find((int)$rid);
		} catch (DoesNotExistException $e) {
			throw new \RuntimeException("Record #$rid not found");
		}
		if ((int)$rec->getCollectionId() !== (int)$c->getId()) {
			throw new \RuntimeException("Record #$rid is not in collection #{$c->getId()}");
		}

		$key = $this->secretKey($c->getUserId(), $input, $output);
		$data = json_decode($rec->getData() ?: '{}', true) ?: [];
		$fields = $this->fields->findForCollection((int)$c->getId());

		// --field: print one value raw and stop (scriptable).
		$only = $input->getOption('field');
		if (is_string($only) && $only !== '') {
			foreach ($fields as $f) {
				if ($f->getFieldKey() === $only || $f->getLabel() === $only) {
					$output->write($this->reveal($key, $data[$f->getFieldKey()] ?? '') ?? '');
					return 0;
				}
			}
			throw new \RuntimeException("No field '$only' in this collection");
		}

		$rows = [];
		foreach ($fields as $f) {
			$rows[] = [
				'key' => $f->getFieldKey(),
				'label' => $f->getLabel(),
				'secret' => (bool)$f->getSecret(),
				'value' => $this->reveal($key, $data[$f->getFieldKey()] ?? ''),
			];
		}

		if ($input->getOption('output') === 'json') {
			$output->writeln(json_encode([
				'id' => (int)$rec->getId(),
				'collection_id' => (int)$c->getId(),
				'fields' => $rows,
				'created_at' => $rec->getCreatedAt(),
				'updated_at' => $rec->getUpdatedAt(),
			], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
			return 0;
		}

		$output->writeln(sprintf('<info>%s %s</info> — record #%d', $c->getIcon(), $c->getName(), $rec->getId()));
		$table = new Table($output);
		$table->setHeaders(['Field', 'Value']);
		foreach ($rows as $r) {
			$label = $r['label'] . ($r['secret'] ? ' 🔒' : '');
			$table->addRow([$label, $r['value']]);
		}
		$table->render();
		return 0;
	}
}
